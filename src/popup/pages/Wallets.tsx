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

import { Icon, type IconName } from "../Icon";
import { Modal } from "../components/Modal";
import { PasswordGate } from "../components/PasswordGate";
import { ConfirmWordDialog } from "../components/ConfirmWordDialog";
import { useFitText } from "../components/useFitText";
import { bech32mDisplay } from "../../shared/bech32m";
import { homeAvailableDisplay } from "../../shared/native-amount";
import { formatFiat, getLythFiatRate } from "../../shared/fiat";
import { useDisplayCurrencyPref } from "../hooks/useDisplayPrefs";
import {
  bgVaultVerifyPassword,
  bgVaultRemove,
  bgVaultRename,
  bgVaultSelect,
  bgVaultMultisigMeta,
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

/** Per-action gate prompts. Same shape as the page-entry prompt and as
 *  ResetWallet's "Confirm your password to start the reset flow." Exported so
 *  they are pinnable — the action sheet mounts a Modal and cannot be rendered
 *  in this test env. */
export const REVEAL_GATE_PROMPT =
  "Enter your password to view this wallet's 24-word recovery phrase.";
export const REMOVE_GATE_PROMPT =
  "Confirm your password to remove this wallet.";

/**
 * Whether the remove action may be offered at all.
 *
 * Hidden at one wallet rather than shown-and-refused: removing the only wallet
 * would leave `activeVaultId` dangling and brick the container at next unlock,
 * so the keystore refuses it outright. Surfacing that refusal only AFTER a
 * password gate, a typed DELETE, and an Argon2id derivation would be a cruel
 * way to say "not possible". The keystore guard stays as defence in depth —
 * this is the UI declining to offer an action it knows cannot succeed.
 */
export function canRemoveWallet(walletCount: number): boolean {
  return walletCount > 1;
}

/**
 * The warning shown before a removal is confirmed.
 *
 * Names the wallet, and — when known — its balance and any multisig wallets
 * that listed it as a signer. The unrecoverability sentence itself is NOT here:
 * ConfirmWordDialog supplies `RECOVERY_PHRASE_WARNING` as its default body,
 * which is ResetWallet's wording verbatim.
 */
export function removeWarningHeading(label: string): string {
  return `This permanently deletes ${label} from this browser.`;
}

/** One multisig wallet's roster, as read for the pre-removal scan. */
export interface MultisigRosterEntry {
  label: string;
  vaultId: string;
  signers: readonly { address: string; vaultId?: string }[];
}

/**
 * Labels of multisig wallets whose signer roster references the target.
 *
 * `removeVaultV4` returns the same list, but only AFTER the removal — too late
 * to warn anyone. The rosters are readable without unlocking
 * (`bgVaultMultisigMeta`), so the warning is computed here from the same
 * matching rule the keystore uses: the self-signer's `vaultId` where present,
 * the address otherwise, so external entries naming the same address count too.
 *
 * Removing a signer does not corrupt the multisig's roster — it destroys the
 * key that signs for it. The user has to be told which wallets lose a signer.
 */
export function multisigLabelsReferencing(
  entries: readonly MultisigRosterEntry[],
  targetVaultId: string,
  targetAddr: string,
): string[] {
  const addr = targetAddr.toLowerCase();
  return entries
    .filter(
      (e) =>
        e.vaultId !== targetVaultId &&
        e.signers.some(
          (s) => s.vaultId === targetVaultId || s.address.toLowerCase() === addr,
        ),
    )
    .map((e) => e.label);
}

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
  /** Routes to the shared RevealPhrase screen, targeted at one wallet. The
   *  label rides along so the reveal header can attribute the phrase. */
  onRevealPhrase: (vaultId: string, label: string) => void;
}

export function Wallets({ chainIdHex, onBack, onRevealPhrase }: WalletsProps) {
  const [step, setStep] = useState<Step>("reauth");
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, WalletBalanceState>>(
    {},
  );
  // The row whose action sheet is open. Holding the whole summary (not just an
  // id) means a background list refresh cannot retarget an open sheet.
  const [sheetFor, setSheetFor] = useState<VaultSummary | null>(null);
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
            onOpen={() => setSheetFor(v)}
          />
        ))}
      </div>

      {sheetFor && (
        <WalletActionSheet
          vault={sheetFor}
          allVaults={vaults ?? []}
          balance={balances[sheetFor.id] ?? { kind: "pending" }}
          canRemove={canRemoveWallet(vaults?.length ?? 0)}
          onClose={() => setSheetFor(null)}
          onRenamed={() => {
            setSheetFor(null);
            void loadVaults();
          }}
          onReveal={() => {
            const target = sheetFor;
            setSheetFor(null);
            onRevealPhrase(target.id, target.label);
          }}
          onRemoved={() => {
            setSheetFor(null);
            // Re-read rather than splice locally: the keystore may also have
            // elected a new active wallet, and the list must reflect that.
            void loadVaults();
          }}
          onActivated={() => {
            setSheetFor(null);
            // Re-read so the Active marker moves. App re-hydrates the header
            // chip separately, off the container's storage change.
            void loadVaults();
          }}
        />
      )}
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
  onOpen: () => void;
}

function WalletRow({ vault, balance, onOpen }: WalletRowProps) {
  const [displayCurrency] = useDisplayCurrencyPref();
  // Full bech32m, never truncated — fitted to the row width instead of cut.
  const fullAddr = bech32mDisplay(vault.addr);
  const addrFitRef = useFitText<HTMLDivElement>(fullAddr, 11);
  const lyth = walletBalanceText(balance);

  return (
    <div
      className="ext-card"
      style={ROW_STYLE}
      role="button"
      tabIndex={0}
      aria-label={`Manage ${vault.label}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
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

// ---------------------------------------------------------------------------
// Per-wallet action sheet
// ---------------------------------------------------------------------------

/** Which gate the sheet is currently showing.
 *
 *  A single machine, not two independently mounted controls: `remove-confirm`
 *  is reachable ONLY from `remove-auth`, so the typed-DELETE step cannot be
 *  reached without the password step having advanced. The keystore re-verifies
 *  the password on submit regardless — the UI order is usability, the keystore
 *  is the boundary. */
type SheetStep = "menu" | "rename" | "remove-auth" | "remove-confirm";

interface WalletActionSheetProps {
  vault: VaultSummary;
  /** Every wallet, so the multisig roster scan knows where to look. */
  allVaults: readonly VaultSummary[];
  balance: WalletBalanceState;
  canRemove: boolean;
  onClose: () => void;
  onRenamed: () => void;
  onReveal: () => void;
  onRemoved: () => void;
  onActivated: () => void;
}

function WalletActionSheet({
  vault,
  allVaults,
  balance,
  canRemove,
  onClose,
  onRenamed,
  onReveal,
  onRemoved,
  onActivated,
}: WalletActionSheetProps) {
  const [step, setStep] = useState<SheetStep>("menu");
  const [renameValue, setRenameValue] = useState(vault.label);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Captured when the password step clears, and consumed by the confirm step's
  // submit. Cleared on every exit so a cancelled removal carries nothing
  // forward. Held transiently because the KDF needs the plaintext; the keystore
  // re-derives from it and nothing here inspects or stores it.
  const [password, setPassword] = useState("");
  // Snapshotted when the sheet opened. A background list refresh cannot
  // retarget an in-flight removal, and the keystore re-finds by id anyway.
  const targetId = vault.id;
  const targetLabel = vault.label;

  useEffect(() => {
    return () => {
      setPassword("");
    };
  }, []);

  // Which multisig wallets would lose a signer. Read once when the sheet opens
  // so the warning is ready before the user reaches the confirm step. Rosters
  // are non-secret and need no unlock.
  const [affectedMultisig, setAffectedMultisig] = useState<string[]>([]);
  useEffect(() => {
    const others = allVaults.filter(
      (v) => v.kind === "multisig" && v.id !== targetId,
    );
    if (others.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries: MultisigRosterEntry[] = [];
      for (const v of others) {
        const r = await bgVaultMultisigMeta(v.id);
        if (cancelled) return;
        if (r.ok && r.meta) {
          entries.push({ label: v.label, vaultId: v.id, signers: r.meta.signers });
        }
      }
      if (cancelled) return;
      setAffectedMultisig(
        multisigLabelsReferencing(entries, targetId, vault.addr),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [allVaults, targetId, vault.addr]);

  const close = () => {
    setPassword("");
    onClose();
  };

  const handleRename = async () => {
    const trimmed = renameValue.trim();
    if (submitting || trimmed.length === 0 || trimmed === vault.label) return;
    setSubmitting(true);
    setError(null);
    const r = await bgVaultRename(targetId, trimmed);
    setSubmitting(false);
    if (r.ok) {
      onRenamed();
      return;
    }
    setError(r.reason ?? "Could not rename wallet.");
  };

  const handleSetActive = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // The same op VaultPicker's row-click uses — selection is not
      // reimplemented here. No password gate: switching the active wallet is
      // neither destructive nor a disclosure, so it follows the rename
      // precedent. App re-hydrates off the container's storage change, so the
      // header chip and active account follow without a manual reload.
      const r = await bgVaultSelect(targetId);
      if (r.ok) {
        onActivated();
        return;
      }
      setError(r.reason ?? "Could not switch wallet.");
    } catch (e) {
      setError((e as Error).message ?? "Could not switch wallet.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    let r: Awaited<ReturnType<typeof bgVaultRemove>>;
    try {
      r = await bgVaultRemove(password, targetId);
    } catch (e) {
      setError((e as Error).message ?? "Could not remove wallet.");
      setStep("remove-auth");
      return;
    } finally {
      // Cleared on EVERY exit, including a throw — a failed transport must not
      // leave the plaintext resident in component state.
      setPassword("");
      setSubmitting(false);
    }
    if (r.ok) {
      onRemoved();
      return;
    }
    // A refusal the user cannot fix by retyping (the last-wallet guard, a
    // locked container) comes back verbatim; a wrong password comes back as
    // wrong_password. Either way the user is bounced to the password step
    // rather than left staring at an armed confirm button.
    setError(
      r.reason === "wrong_password"
        ? "Wrong password."
        : r.reason ?? "Could not remove wallet.",
    );
    setStep("remove-auth");
  };

  const lyth = walletBalanceText(balance);

  if (step === "rename") {
    const trimmed = renameValue.trim();
    const canSave =
      !submitting && trimmed.length > 0 && trimmed.length <= 32 && trimmed !== vault.label;
    return (
      <Modal open onClose={close} title="Rename wallet" showClose>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            type="text"
            value={renameValue}
            autoFocus
            maxLength={32}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
            }}
            style={RENAME_INPUT_STYLE}
          />
          {error && <div style={SHEET_ERROR_STYLE}>{error}</div>}
          <div style={SHEET_FOOTER_STYLE}>
            <button onClick={close} disabled={submitting} style={SHEET_CANCEL_STYLE}>
              Cancel
            </button>
            <button
              onClick={() => void handleRename()}
              disabled={!canSave}
              style={{ ...SHEET_PRIMARY_STYLE, opacity: canSave ? 1 : 0.45 }}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (step === "remove-auth") {
    return (
      <Modal open onClose={close} title={`Remove ${targetLabel}?`} showClose>
        <PasswordGate
          variant="inline"
          prompt={REMOVE_GATE_PROMPT}
          fallbackError="Could not verify password."
          // Verified here so a wrong password costs one derivation and stops,
          // instead of carrying a bad password into the destructive submit.
          verify={(pw) => bgVaultVerifyPassword(pw)}
          onVerified={(_verdict, verified) => {
            // Carry the verified password to the submit step. The keystore
            // re-derives and re-verifies it there regardless — this gate is
            // usability, not the boundary — but it has to receive the real
            // string to do so. handleRemove clears it in a finally.
            setPassword(verified);
            setError(null);
            setStep("remove-confirm");
          }}
          onCancel={close}
        />
        {error && <div style={SHEET_ERROR_STYLE}>{error}</div>}
      </Modal>
    );
  }

  if (step === "remove-confirm") {
    return (
      <ConfirmWordDialog
        open
        onClose={close}
        title={`Remove ${targetLabel}?`}
        warningHeading={removeWarningHeading(targetLabel)}
        error={error}
        confirmLabel="Remove wallet"
        busyLabel="Removing…"
        submitting={submitting}
        onConfirm={() => void handleRemove()}
      >
        {/* Everything the user needs to know BEFORE confirming. */}
        {lyth !== null && lyth !== "0.00" && (
          <div style={SHEET_NOTE_STYLE}>
            This wallet holds <strong>{lyth} LYTH</strong>. Removing it does not
            move the funds — they stay at this address on-chain, reachable only
            with the recovery phrase.
          </div>
        )}
        {vault.isActive && (
          <div style={SHEET_NOTE_STYLE}>
            This is your active wallet. Another wallet becomes active after it
            is removed.
          </div>
        )}
        {vault.kind === "multisig" && vault.pendingCount > 0 && (
          <div style={SHEET_NOTE_STYLE}>
            This multisig wallet has <strong>{vault.pendingCount}</strong>{" "}
            pending {vault.pendingCount === 1 ? "proposal" : "proposals"}.
          </div>
        )}
        {affectedMultisig.length > 0 && (
          <div style={SHEET_NOTE_STYLE}>
            <strong>{affectedMultisig.join(", ")}</strong>{" "}
            {affectedMultisig.length === 1 ? "lists" : "list"} this wallet as a
            signer. {affectedMultisig.length === 1 ? "It keeps" : "They keep"}{" "}
            the roster entry but {affectedMultisig.length === 1 ? "loses" : "lose"}{" "}
            the key that signs for it.
          </div>
        )}
      </ConfirmWordDialog>
    );
  }

  return (
    <Modal
      open
      onClose={close}
      title={targetLabel}
      description={bech32mDisplay(vault.addr)}
      showClose
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {/* Hidden on the wallet that is already active — the list already marks
           it, so offering a no-op is noise. First in the list: it is the most
           benign action here, and it keeps the furthest distance from remove. */}
        {!vault.isActive && (
          <SheetAction
            icon="check"
            label="Set as active wallet"
            onClick={() => void handleSetActive()}
          />
        )}
        <SheetAction
          icon="pen"
          label="Rename wallet"
          onClick={() => {
            setError(null);
            setRenameValue(vault.label);
            setStep("rename");
          }}
        />
        <SheetAction icon="eye" label="Show recovery phrase" onClick={onReveal} />
        {/* Absent, not disabled, when this is the only wallet: the keystore
           would refuse it, and offering an action that cannot succeed only to
           refuse after a password and a typed DELETE is not a real choice. */}
        {canRemove && (
          <SheetAction
            icon="trash"
            label="Remove wallet"
            danger
            onClick={() => {
              setError(null);
              setStep("remove-auth");
            }}
          />
        )}
        {/* A failed switch has nowhere else to surface — the sheet stays on the
           menu step rather than advancing. */}
        {error && <div style={SHEET_ERROR_STYLE}>{error}</div>}
      </div>
    </Modal>
  );
}

function SheetAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "11px 6px",
        background: "transparent",
        border: "none",
        color: danger ? "var(--err)" : "var(--fg-100)",
        fontFamily: "var(--f-sans)",
        fontSize: 13,
        fontWeight: 500,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <Icon name={icon} size={14} />
      <span style={{ flex: 1 }}>{label}</span>
      <Icon name="chev" size={11} />
    </button>
  );
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginBottom: 8,
  cursor: "pointer",
};

const SHEET_FOOTER_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
  marginTop: 2,
};

const SHEET_CANCEL_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const SHEET_PRIMARY_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(124,127,255,0.6)",
  background: "rgba(124,127,255,0.18)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const RENAME_INPUT_STYLE: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const SHEET_ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  color: "var(--err)",
  lineHeight: 1.4,
};

const SHEET_NOTE_STYLE: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-200)",
  lineHeight: 1.5,
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
