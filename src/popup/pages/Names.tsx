// Names page — §22.8 hierarchical name registration + management (0x110E).
//
// Gated behind the REGISTRY feature flag. v1 scope: register a Human/Agent
// `.mono` name (this file / commit 3). Transfer management (propose + accept)
// and the best-effort owned-names ledger append as cards below in later commits.
//
// WYSIWYS is the safety anchor: the confirm step shows the exact name, its
// category, and the exact cost (a real LYTH spend) BEFORE the user signs. The
// cost is quoted from the live base price via the SW; an unquotable cost blocks
// the flow (no-mock — never a fabricated price).

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "../Icon";
import { CategoryBadge } from "../components/CategoryBadge";
import { bgWalletNameQuote, bgWalletNameRegister } from "../bg";
import { validateRegisterableName } from "../../shared/name-registry.js";
import { formatLythoshiToLythDecimal } from "../../shared/lyth-units.js";
import { parseHexQuantity } from "../../shared/native-amount.js";

export interface NamesProps {
  chainIdHex: string;
  onBack: () => void;
}

/** Format a lythoshi cost hex as a full-precision LYTH string (name costs are
 *  tiny — nano-LYTH at the base-fee floor — so no rounding). */
function costHexToLyth(costLythoshiHex: string): string | null {
  const v = parseHexQuantity(costLythoshiHex);
  if (v === null) return null;
  return formatLythoshiToLythDecimal(v);
}

type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; canonical: string; category: string; costLythoshiHex: string }
  | { status: "error"; message: string };

type SubmitState =
  | { status: "idle" }
  | { status: "confirm"; canonical: string; category: string; costLythoshiHex: string }
  | { status: "submitting" }
  | { status: "done"; canonical: string; txHash: string }
  | { status: "error"; message: string };

export function Names({ chainIdHex, onBack }: NamesProps) {
  const [name, setName] = useState("");
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  const trimmed = name.trim().toLowerCase();
  const validation = trimmed.length > 0 ? validateRegisterableName(trimmed) : null;
  const clientValid = validation?.ok === true;

  // Live quote on a short debounce whenever the client-valid name changes.
  useEffect(() => {
    setSubmit({ status: "idle" });
    if (!clientValid) {
      setQuote({ status: "idle" });
      return;
    }
    let cancelled = false;
    setQuote({ status: "loading" });
    const t = setTimeout(() => {
      void (async () => {
        const r = await bgWalletNameQuote(trimmed, chainIdHex);
        if (cancelled) return;
        if (r.ok) {
          setQuote({
            status: "ok",
            canonical: r.canonical,
            category: r.category,
            costLythoshiHex: r.costLythoshiHex,
          });
        } else {
          setQuote({
            status: "error",
            message: r.reason ?? "Couldn't fetch a price. Try again.",
          });
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trimmed, clientValid, chainIdHex]);

  const goConfirm = () => {
    if (quote.status !== "ok") return;
    setSubmit({
      status: "confirm",
      canonical: quote.canonical,
      category: quote.category,
      costLythoshiHex: quote.costLythoshiHex,
    });
  };

  const doRegister = async () => {
    if (submit.status !== "confirm") return;
    const canonical = submit.canonical;
    setSubmit({ status: "submitting" });
    const r = await bgWalletNameRegister(canonical, chainIdHex);
    if (r.ok) {
      setSubmit({ status: "done", canonical: r.canonical, txHash: r.txHash });
      setName("");
      setQuote({ status: "idle" });
    } else {
      setSubmit({
        status: "error",
        message: r.reason ?? "Registration failed.",
      });
    }
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}>
          Names
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Register a name</h3>
          </div>
          <div style={intro}>
            Claim a human name like <code style={code}>alice.mono</code> or an
            agent name like <code style={code}>bot.agent.alice.mono</code> under a
            name you own. Registration is a one-time on-chain fee — names never
            expire.
          </div>

          {submit.status === "done" ? (
            <div style={okBox}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {submit.canonical} submitted
              </div>
              <div style={{ fontSize: 10.5, color: "var(--fg-400)", wordBreak: "break-all" }}>
                tx {submit.txHash}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--fg-400)", marginTop: 6 }}>
                It becomes resolvable once the transaction is included. If the name
                was taken in a race, the transaction reverts and the fee is
                returned.
              </div>
              <button style={{ ...primaryBtn, marginTop: 10 }} onClick={() => setSubmit({ status: "idle" })}>
                Register another
              </button>
            </div>
          ) : submit.status === "confirm" ? (
            <div style={confirmBox}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                Confirm registration
              </div>
              <Row label="Name" value={<span style={mono}>{submit.canonical}</span>} />
              <Row label="Category" value={<CategoryBadge category={submit.category} />} />
              <Row
                label="Cost"
                value={
                  <span style={mono}>
                    {costHexToLyth(submit.costLythoshiHex) ?? "—"} LYTH
                  </span>
                }
              />
              <div style={{ fontSize: 10.5, color: "var(--fg-400)", margin: "6px 0 10px" }}>
                Plus the network fee (paid in LYTH). The cost is re-checked against
                the live price at signing.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  style={{ ...ghostBtn, flex: 1 }}
                  onClick={() => setSubmit({ status: "idle" })}
                >
                  Cancel
                </button>
                <button style={{ ...primaryBtn, flex: 1 }} onClick={() => void doRegister()}>
                  Register
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="alice.mono"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                style={input}
              />
              {validation && !validation.ok && (
                <div style={hint}>{validation.message}</div>
              )}
              {clientValid && quote.status === "loading" && (
                <div style={hint}>Checking price…</div>
              )}
              {clientValid && quote.status === "error" && (
                <div style={errText}>{quote.message}</div>
              )}
              {quote.status === "ok" && (
                <div style={quoteRow}>
                  <CategoryBadge category={quote.category} />
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: "var(--fg-300)" }}>Cost</span>
                  <span style={{ ...mono, fontSize: 12 }}>
                    {costHexToLyth(quote.costLythoshiHex) ?? "—"} LYTH
                  </span>
                </div>
              )}
              {submit.status === "error" && (
                <div style={errBox}>{submit.message}</div>
              )}
              <button
                style={{ ...primaryBtn, marginTop: 10, opacity: quote.status === "ok" ? 1 : 0.5 }}
                disabled={quote.status !== "ok"}
                onClick={goConfirm}
              >
                Continue
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--fg-400)", minWidth: 68 }}>{label}</span>
      <span style={{ flex: 1, textAlign: "right" }}>{value}</span>
    </div>
  );
}

const intro: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-300)",
  lineHeight: 1.5,
  marginBottom: 12,
};
const code: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  padding: "1px 4px",
  borderRadius: 4,
  background: "rgba(255,255,255,0.06)",
};
const mono: CSSProperties = { fontFamily: "var(--f-mono)", fontSize: 12 };
const input: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 13,
  boxSizing: "border-box",
};
const hint: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-400)",
  marginTop: 6,
  lineHeight: 1.4,
};
const errText: CSSProperties = { ...hint, color: "var(--err)" };
const quoteRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 10,
};
const primaryBtn: CSSProperties = {
  width: "100%",
  padding: "9px 16px",
  borderRadius: 8,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};
const ghostBtn: CSSProperties = {
  padding: "9px 16px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "transparent",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};
const confirmBox: CSSProperties = {
  padding: 12,
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.03)",
};
const okBox: CSSProperties = {
  padding: 12,
  borderRadius: 8,
  border: "1px solid rgba(120,200,120,0.35)",
  background: "rgba(120,200,120,0.08)",
  fontSize: 12,
};
const errBox: CSSProperties = {
  fontSize: 11,
  color: "var(--err)",
  padding: 8,
  border: "1px solid rgba(220,80,80,0.4)",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
  marginTop: 10,
};
