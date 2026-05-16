// Phase 9 Commit 3 — Security page.
//
// Surfaces the §28.5 Q30 + Q31 passkey policy: list of registered
// credentials, register-new CTA, policy editor with limit slider +
// per-tx vs daily-cap mode toggle + master enable switch.
//
// Read-after-write is the page's contract — every IPC call returns
// the freshly-persisted state, which the page caches in local state
// and re-renders from. No optimistic UI; if a write fails the page
// stays on the prior state.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import {
  bgPasskeyGetState,
  bgPasskeyRemoveCredential,
  bgPasskeySetPolicy,
  type BgPasskeyState,
  type BgPasskeyPolicy,
  type BgPolicyMode,
} from "../bg";
import { PasskeyRegisterModal } from "../components/PasskeyRegisterModal";
import { SlhDsaBackupCard } from "../components/SlhDsaBackupCard";
import {
  DEFAULT_PASSKEY_DAILY_CAP_WEI,
  DEFAULT_PASSKEY_LIMIT_WEI,
  MAX_PASSKEY_LIMIT_WEI,
  MIN_PASSKEY_LIMIT_WEI,
} from "../../shared/passkey";

export interface SecurityProps {
  onBack: () => void;
  /** Active vault id — passkey state is per-vault. */
  vaultId: string;
  /** Vault address — surfaced inside the WebAuthn user block during
   *  registration. */
  vaultAddress: string;
  /** Active chain id (hex). Threaded through to the Phase 10 backup
   *  card so its on-chain registration submit knows which chain to
   *  target. */
  chainIdHex: string;
}

/** Convert wei (decimal string) → LYTH (decimal string with ≤ 4 dp).
 *  Used for the slider readout and the policy summary card. Exported
 *  for the unit-test seam. */
export function weiStrToLythStr(weiStr: string): string {
  try {
    const wei = BigInt(weiStr);
    const ONE = 1_000_000_000_000_000_000n;
    const integer = wei / ONE;
    const fraction = wei % ONE;
    if (fraction === 0n) return integer.toString();
    // 4 dp display ceiling. Pad and trim.
    const fracStr = fraction.toString().padStart(18, "0").slice(0, 4);
    const trimmed = fracStr.replace(/0+$/, "");
    return trimmed ? `${integer}.${trimmed}` : integer.toString();
  } catch {
    return "?";
  }
}

/** Convert LYTH integer → wei decimal-string. Used by the slider.
 *  Exported for the unit-test seam. */
export function lythToWeiStr(lyth: number): string {
  // Use bigint to avoid the float-imprecision footgun at large
  // values. 1 LYTH = 1e18 wei.
  const whole = BigInt(Math.floor(lyth));
  return (whole * 1_000_000_000_000_000_000n).toString();
}

/** Slider domain — 11 stops covering 1, 5, 10, 25, 50, 100, 250, 500,
 *  1000, 5000, 10000 LYTH. Discrete stops keep the math cheap and the
 *  UX clear; the underlying validator still accepts any value within
 *  [MIN, MAX]. */
const SLIDER_STOPS_LYTH = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000] as const;

/** Index of the slider stop that's closest to the supplied wei value.
 *  Exported for the unit-test seam. */
export function closestStopIndex(weiStr: string): number {
  try {
    const wei = BigInt(weiStr);
    const lyth = Number(wei / 1_000_000_000_000_000_000n);
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < SLIDER_STOPS_LYTH.length; i++) {
      const d = Math.abs(SLIDER_STOPS_LYTH[i]! - lyth);
      if (d < bestDelta) {
        best = i;
        bestDelta = d;
      }
    }
    return best;
  } catch {
    return SLIDER_STOPS_LYTH.indexOf(100); // default position
  }
}

export function Security({
  onBack,
  vaultId,
  vaultAddress,
  chainIdHex,
}: SecurityProps) {
  const [state, setState] = useState<BgPasskeyState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const refresh = async () => {
    setLoadErr(null);
    const r = await bgPasskeyGetState(vaultId);
    if (r.ok) {
      setState(r.state);
    } else {
      setLoadErr(r.reason);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  const handleRemove = async (credentialId: string) => {
    setSaving(true);
    setSaveErr(null);
    const r = await bgPasskeyRemoveCredential({ vaultId, credentialId });
    if (r.ok) setState(r.state);
    else setSaveErr(r.reason);
    setSaving(false);
  };

  const handleSetPolicy = async (patch: Partial<BgPasskeyPolicy>) => {
    if (!state) return;
    setSaving(true);
    setSaveErr(null);
    const next: BgPasskeyPolicy = { ...state.policy, ...patch };
    const r = await bgPasskeySetPolicy({ vaultId, policy: next });
    if (r.ok) setState(r.state);
    else setSaveErr(r.reason);
    setSaving(false);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = parseInt(e.target.value, 10);
    if (Number.isNaN(idx)) return;
    const lyth = SLIDER_STOPS_LYTH[idx]!;
    const weiStr = lythToWeiStr(lyth);
    // Keep dailyCap ≥ limitWei to avoid the daily-cap-below-per-tx
    // validation tripwire — promote the cap when the slider pushes
    // the limit past it.
    const currentDaily = state ? BigInt(state.policy.dailyCapWei) : DEFAULT_PASSKEY_DAILY_CAP_WEI;
    const dailyCapStr = currentDaily < BigInt(weiStr) ? weiStr : currentDaily.toString();
    void handleSetPolicy({ limitWei: weiStr, dailyCapWei: dailyCapStr });
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>
          Security
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Passkey policy</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Use Windows Hello, Touch ID, or a security key for fast unlock on
            small-value transfers. Password unlock is still required above
            the configured limit and for vault management.
          </div>

          {loadErr && (
            <div style={errBox}>Could not load policy: {loadErr}</div>
          )}

          {state && (
            <>
              {/* Master enable toggle */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--fg-700)",
                  background: "rgba(255,255,255,0.04)",
                  marginBottom: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>
                    {state.policy.enabled ? "Enabled" : "Disabled"}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-400)", marginTop: 2 }}>
                    {state.credentials.length === 0
                      ? "Register a passkey to enable the policy"
                      : state.policy.enabled
                      ? "Small txs unlock with your passkey"
                      : "All txs require password unlock"}
                  </div>
                </div>
                <button
                  onClick={() =>
                    void handleSetPolicy({ enabled: !state.policy.enabled })
                  }
                  disabled={saving || state.credentials.length === 0}
                  style={{
                    ...toggleBtn,
                    background: state.policy.enabled
                      ? "var(--gold-bg)"
                      : "rgba(255,255,255,0.04)",
                    borderColor: state.policy.enabled
                      ? "var(--gold)"
                      : "var(--fg-700)",
                    color: state.policy.enabled ? "var(--gold)" : "var(--fg-100)",
                    opacity:
                      state.credentials.length === 0 || saving ? 0.5 : 1,
                  }}
                >
                  {state.policy.enabled ? "On" : "Off"}
                </button>
              </div>

              {/* Mode picker */}
              <div style={{ marginBottom: 10 }}>
                <div style={labelLabel}>Enforcement</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {(["per-tx", "daily"] as BgPolicyMode[]).map((m) => {
                    const active = state.policy.mode === m;
                    return (
                      <button
                        key={m}
                        onClick={() => void handleSetPolicy({ mode: m })}
                        disabled={saving}
                        style={{
                          ...modeBtn,
                          borderColor: active ? "var(--gold)" : "var(--fg-700)",
                          background: active ? "var(--gold-bg)" : "rgba(255,255,255,0.04)",
                          color: active ? "var(--gold)" : "var(--fg-100)",
                        }}
                      >
                        {m === "per-tx" ? "Per-tx" : "Daily cap"}
                        <div style={modeBtnHint}>
                          {m === "per-tx"
                            ? "Each tx must be under the limit"
                            : "Total spend / 24h must be under the cap"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Per-tx slider */}
              <div style={{ marginBottom: 10 }}>
                <div style={labelLabel}>
                  Per-tx limit:{" "}
                  <span style={{ color: "var(--gold)" }}>
                    {weiStrToLythStr(state.policy.limitWei)} LYTH
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={SLIDER_STOPS_LYTH.length - 1}
                  step={1}
                  value={closestStopIndex(state.policy.limitWei)}
                  onChange={handleSliderChange}
                  disabled={saving}
                  style={{ width: "100%" }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 9.5,
                    color: "var(--fg-400)",
                    fontFamily: "var(--f-mono)",
                  }}
                >
                  <span>{weiStrToLythStr(MIN_PASSKEY_LIMIT_WEI.toString())} LYTH</span>
                  <span>{weiStrToLythStr(DEFAULT_PASSKEY_LIMIT_WEI.toString())} LYTH (default)</span>
                  <span>{weiStrToLythStr(MAX_PASSKEY_LIMIT_WEI.toString())} LYTH</span>
                </div>
              </div>

              {/* Daily cap shown only when daily mode is active */}
              {state.policy.mode === "daily" && (
                <div style={{ marginBottom: 10 }}>
                  <div style={labelLabel}>
                    Daily cap:{" "}
                    <span style={{ color: "var(--gold)" }}>
                      {weiStrToLythStr(state.policy.dailyCapWei)} LYTH
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-400)", lineHeight: 1.5 }}>
                    Daily cap is the rolling 24-hour total of passkey-unlocked
                    transfers. Tracks against transactions signed via passkey
                    only — password-unlocked txs do not count against it.
                  </div>
                </div>
              )}

              {saveErr && <div style={errBox}>{saveErr}</div>}
            </>
          )}
        </div>

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Registered credentials</h3>
          </div>

          {state && state.credentials.length === 0 && (
            <div style={{ fontSize: 11.5, color: "var(--fg-300)", lineHeight: 1.5 }}>
              No passkeys registered for this vault yet. Register one to enable
              fast-unlock on small transfers.
            </div>
          )}

          {state && state.credentials.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {state.credentials.map((c) => (
                <div
                  key={c.credentialId}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--fg-700)",
                    background: "rgba(255,255,255,0.04)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Icon name="passkey" size={14} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.name}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--fg-400)",
                        fontFamily: "var(--f-mono)",
                      }}
                    >
                      {c.kind === "platform" ? "Platform" : "Security key"}
                      {" · "}
                      Added {new Date(c.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    onClick={() => void handleRemove(c.credentialId)}
                    disabled={saving}
                    style={removeBtn}
                    aria-label={`Remove ${c.name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setRegisterOpen(true)}
            style={{
              ...ctaBtn,
              marginTop: state && state.credentials.length > 0 ? 10 : 0,
            }}
          >
            <Icon name="passkey" size={12} />
            Register new passkey
          </button>
        </div>

        {/* Phase 10 — SLH-DSA emergency backup card */}
        <SlhDsaBackupCard
          vaultId={vaultId}
          vaultAddressLabel={vaultAddress}
          chainIdHex={chainIdHex}
        />
      </div>

      <PasskeyRegisterModal
        open={registerOpen}
        vaultId={vaultId}
        vaultAddress={vaultAddress}
        onClose={() => setRegisterOpen(false)}
        onRegistered={(s) => {
          setState(s);
          setRegisterOpen(false);
        }}
      />
    </>
  );
}

const labelLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  marginBottom: 6,
};

const toggleBtn: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "1px solid",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 150ms var(--e-out)",
};

const modeBtn: CSSProperties = {
  padding: "8px 8px",
  borderRadius: 8,
  border: "1px solid",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  cursor: "pointer",
  textAlign: "left",
  transition: "all 150ms var(--e-out)",
};

const modeBtnHint: CSSProperties = {
  fontSize: 9.5,
  marginTop: 2,
  color: "var(--fg-400)",
};

const errBox: CSSProperties = {
  fontSize: 11,
  color: "var(--err)",
  padding: 8,
  border: "1px solid rgba(220,80,80,0.4)",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
  marginTop: 8,
};

const removeBtn: CSSProperties = {
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid rgba(220,80,80,0.4)",
  background: "rgba(220,80,80,0.08)",
  color: "var(--err)",
  fontFamily: "var(--f-sans)",
  fontSize: 10.5,
  cursor: "pointer",
};

const ctaBtn: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};
