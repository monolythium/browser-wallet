// Wallets — see and manage every wallet in the extension.
//
// Entry is password-gated. The wallet is already unlocked to reach this page,
// so the gate is not about the wallet at rest: it defends against an
// unattended already-unlocked popup, which is exactly the threat that matters
// for a surface that can reveal any wallet's recovery phrase and delete any
// wallet. The gate follows the established in-screen step-machine idiom
// (RevealPhrase's "reauth" -> ..., ResetWallet's "reauth" -> "confirm") rather
// than a route guard; this codebase has no route-guard mechanism.
//
// The gate verifies via `bgVaultVerifyPassword`, which retrieves NOTHING. It is
// deliberately not a seed export used as a password check.
//
// Balances are fetched per wallet at a small concurrency cap and rendered
// progressively. The list never blocks on the network: it paints from
// `bgVaultsList` (no unlock, no network) and each balance fills in as it lands.
// A read that fails, or has not arrived, renders the house absence marker —
// never a fabricated `0.00`. A LIVE zero renders `0.00`, because that is a real
// value; the absent-vs-zero distinction is the thing easiest to get wrong here.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { PasswordGate } from "../components/PasswordGate";
import { useFitText } from "../components/useFitText";
import { bech32mDisplay } from "../../shared/bech32m";
import { homeAvailableDisplay } from "../../shared/native-amount";
import { formatFiat, getLythFiatRate } from "../../shared/fiat";
import { useDisplayCurrencyPref } from "../hooks/useDisplayPrefs";
import {
  bgVaultVerifyPassword,
  bgVaultsList,
  bgWalletBalance,
  type VaultSummary,
} from "../bg";

/** How many balance reads may be in flight at once.
 *
 *  Each read fans out to every active operator and, per operator, costs a
 *  genesis probe plus an `eth_getBalance` — two sequential round-trips. Reads
 *  are not batched across addresses and do not coalesce (different payloads),
 *  so N wallets means N independent walks. Firing all of them at once from an
 *  MV3 service worker against what is currently a single host is a
 *  self-inflicted thundering herd; 2 keeps the page responsive at N=20 without
 *  adding a cache layer. */
export const BALANCE_CONCURRENCY = 2;

/** The house absence marker. Matches what Home renders for an unknown balance.
 *  NEVER `0.00` — that would fabricate a value the wallet does not have. */
export const ABSENT = "—";

/** Entry-gate prompt. Modelled on ResetWallet's "Confirm your password to start
 *  the reset flow." — same shape, same verb, no new visual language. Exported
 *  so it is pinnable: this page is not statically renderable end-to-end. */
export const WALLETS_GATE_PROMPT =
  "Confirm your password to manage your wallets.";

export const WALLETS_GATE_FALLBACK_ERROR = "Could not verify password.";

/** Per-wallet balance state.
 *
 *  `pending` and `absent` both render {@link ABSENT}; they are kept distinct so
 *  the row can tell "still loading" from "the read failed" if that ever needs
 *  different treatment. `live` carries a real reading, including a real zero. */
export type WalletBalanceState =
  | { kind: "pending" }
  | { kind: "live"; lythoshi: bigint }
  | { kind: "absent" };

/**
 * The LYTH figure for a row, or `null` when there is nothing honest to show.
 *
 * Returns a string ONLY for a live read — including a live zero, which is a
 * real value and must not be suppressed. Pending and absent both return null,
 * and the row renders {@link ABSENT}. Formatting goes through
 * `homeAvailableDisplay`, the same helper Home's available figure uses, so the
 * two surfaces cannot drift apart.
 */
export function walletBalanceText(state: WalletBalanceState): string | null {
  return state.kind === "live" ? homeAvailableDisplay(state.lythoshi, 2) : null;
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 *
 * Plain worker-pool: `limit` runners pull from a shared cursor until it is
 * exhausted. Results are applied by the worker as they land, so callers render
 * progressively rather than waiting for the whole set. A worker that rejects
 * would abort its runner, so callers must not let it throw.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const n = items.length;
  if (n === 0) return;
  const width = Math.max(1, Math.min(limit, n));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= n) return;
        await worker(items[i]!, i);
      }
    }),
  );
}

type Step = "reauth" | "list";

export interface WalletsProps {
  chainIdHex: string;
  onBack: () => void;
}

export function Wallets({ chainIdHex, onBack }: WalletsProps) {
  const [step, setStep] = useState<Step>("reauth");
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, WalletBalanceState>>(
    {},
  );
  // Guards against a late balance landing after the page has unmounted.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadVaults = useCallback(async () => {
    const r = await bgVaultsList();
    if (!aliveRef.current) return;
    if (!r.ok || r.vaults === null) {
      setVaults([]);
      setListError(
        r.ok ? "Wallets appear after first unlock." : r.reason ?? "Could not load wallets.",
      );
      return;
    }
    setListError(null);
    setVaults(r.vaults);
  }, []);

  // Balances are kicked off only once the list is known, and never block it.
  useEffect(() => {
    if (step !== "list" || vaults === null || vaults.length === 0) return;
    let cancelled = false;
    setBalances(
      Object.fromEntries(
        vaults.map((v) => [v.id, { kind: "pending" } as WalletBalanceState]),
      ),
    );
    void runWithConcurrency(vaults, BALANCE_CONCURRENCY, async (v) => {
      const r = await bgWalletBalance(v.addr, chainIdHex);
      if (cancelled || !aliveRef.current) return;
      setBalances((prev) => ({
        ...prev,
        [v.id]: r.ok
          ? // A live read, including a live zero.
            { kind: "live", lythoshi: BigInt(r.balanceHex) }
          : // Honest absence — the value is never fabricated or zeroed.
            { kind: "absent" },
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [step, vaults, chainIdHex]);

  if (step === "reauth") {
    return (
      <>
        <Header onBack={onBack} title="Wallets" />
        <PasswordGate
          prompt={WALLETS_GATE_PROMPT}
          fallbackError={WALLETS_GATE_FALLBACK_ERROR}
          verify={(pw) => bgVaultVerifyPassword(pw)}
          onVerified={() => {
            setStep("list");
            void loadVaults();
          }}
          onCancel={onBack}
        />
      </>
    );
  }

  return (
    <>
      <Header onBack={onBack} title="Wallets" />
      <div className="ext-body" style={{ paddingTop: 4 }}>
        <div style={EYEBROW_STYLE}>
          Wallets{vaults !== null ? ` · ${vaults.length}` : ""}
        </div>
        {listError && <div style={LIST_ERROR_STYLE}>{listError}</div>}
        {vaults?.map((v) => (
          <WalletRow
            key={v.id}
            vault={v}
            balance={balances[v.id] ?? { kind: "pending" }}
          />
        ))}
      </div>
    </>
  );
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="ext-top">
      <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
        <Icon name="back" size={15} />
      </button>
      <div
        style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}
      >
        {title}
      </div>
      <div style={{ width: 36 }} />
    </div>
  );
}

interface WalletRowProps {
  vault: VaultSummary;
  balance: WalletBalanceState;
}

function WalletRow({ vault, balance }: WalletRowProps) {
  const [displayCurrency] = useDisplayCurrencyPref();
  // Full bech32m, never truncated — fitted to the row width instead of cut.
  const fullAddr = bech32mDisplay(vault.addr);
  const addrFitRef = useFitText<HTMLDivElement>(fullAddr, 11);
  const lyth = walletBalanceText(balance);

  return (
    <div className="ext-card" style={ROW_STYLE}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={LABEL_STYLE} title={vault.label}>
          {vault.label}
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right", minWidth: 0 }}>
          <div style={AMOUNT_STYLE}>{lyth ?? ABSENT}</div>
          <div style={UNIT_STYLE}>LYTH</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {vault.isActive && (
          <span style={ACTIVE_PILL_STYLE}>
            <Icon name="check" size={10} /> Active
          </span>
        )}
        {vault.kind === "multisig" && (
          <span
            style={MULTISIG_PILL_STYLE}
            title={`${vault.threshold} of ${vault.signerCount} multisig${
              vault.pendingCount > 0 ? ` · ${vault.pendingCount} pending` : ""
            }`}
          >
            {vault.threshold}/{vault.signerCount}
            {vault.pendingCount > 0 ? ` · ${vault.pendingCount}p` : ""}
          </span>
        )}
        <span style={{ marginLeft: "auto", ...FIAT_STYLE }}>
          {/* No oracle -> the rate is null -> "<symbol>—". Never "$0". */}
          {lyth === null
            ? ABSENT
            : formatFiat(lyth, displayCurrency, getLythFiatRate(displayCurrency))}
        </span>
      </div>

      <div ref={addrFitRef} style={ADDR_STYLE} title={fullAddr}>
        {fullAddr}
      </div>
    </div>
  );
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginBottom: 8,
};

const EYEBROW_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  padding: "6px 2px 8px",
};

const LIST_ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  color: "var(--fg-400)",
  padding: "8px 2px",
  lineHeight: 1.5,
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--f-sans)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-100)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const AMOUNT_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-100)",
  lineHeight: 1.2,
};

const UNIT_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9,
  letterSpacing: "0.1em",
  color: "var(--fg-400)",
};

const FIAT_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  color: "var(--fg-400)",
};

const ACTIVE_PILL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontFamily: "var(--f-mono)",
  fontSize: 9,
  padding: "1px 5px",
  borderRadius: 4,
  border: "1px solid rgba(var(--gold-glow), 0.4)",
  background: "rgba(var(--gold-glow), 0.08)",
  color: "var(--fg-200)",
  letterSpacing: "0.05em",
};

const MULTISIG_PILL_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9,
  padding: "1px 5px",
  borderRadius: 4,
  border: "1px solid rgba(124,127,255,0.4)",
  background: "rgba(124,127,255,0.08)",
  color: "var(--fg-200)",
  letterSpacing: "0.05em",
};

const ADDR_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  color: "var(--fg-400)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
