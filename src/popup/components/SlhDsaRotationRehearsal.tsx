// Read-only G3 rotation rehearsal.
//
// Surfaces as a small explainer block inside the Settings →
// Security backup card (when the active vault has a registered
// backup). Walks the user through what an actual G3 emergency
// rotation would look like, so the cold-storage mnemonic is not
// abstract — they know exactly what they'd do with it on
// break-day.
//
// This is **read-only** today. The actual
// `emergency-key.rotate` precompile call lands in a future phase
// (a future phase) when the G3 declaration framework matures on
// Sprintnet. Today the chain side has the registration slot live
// + non-gateable (per prior investigation), but the
// rotation-flow runbook + G3 declaration plumbing are still TBD
// per the whitepaper §30.2 + §30.2.1 framework.

import { useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";

export function SlhDsaRotationRehearsal() {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 10,
        borderTop: "1px solid var(--fg-700)",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={triggerBtn}
        aria-expanded={open}
      >
        <span>
          <Icon name="shield" size={11} /> What happens during a G3 emergency?
        </span>
        <Icon name="chev" size={11} />
      </button>

      {open && (
        <div style={panel}>
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-300)",
              lineHeight: 1.55,
              marginBottom: 8,
            }}
          >
            If a future cryptographic break invalidates ML-DSA, Mono Labs
            declares a <strong>G3 algorithm freeze</strong>. The chain
            refuses transactions signed with the broken algorithm at a
            specified block height. Users with a registered SLH-DSA
            backup rotate to it; users without one are frozen at the
            chain layer (recoverable, but with significant friction).
          </div>

          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Your rotation runbook
          </div>
          <ol style={listStyle}>
            <li>
              <strong>Wait for the G3 declaration.</strong> The wallet
              will surface it as a chain-wide banner with the activation
              block height + an "I'm ready to rotate" CTA.
            </li>
            <li>
              <strong>Re-import your 24-word backup phrase.</strong> The
              wallet decodes the BIP-39 entropy back to the same
              SLH-DSA keypair you registered (the keygen is deterministic
              from the entropy + the wallet's domain tag).
            </li>
            <li>
              <strong>Sign the rotation tx with the backup.</strong> The
              wallet calls <code>emergency-key.rotate</code> on the
              precompile at <code>0x1100</code>, with a signature from
              the SLH-DSA backup that the chain verifies against the
              public key you registered today.
            </li>
            <li>
              <strong>Generate a fresh primary key.</strong> Your account
              now has a new ML-DSA-65 keypair (or whatever the new
              standard post-G3 is). The old primary is dead; the rotation
              is one-shot per emergency.
            </li>
          </ol>

          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-400)",
              fontStyle: "italic",
              marginTop: 10,
              lineHeight: 1.5,
            }}
          >
            The actual rotation UI is a Phase 10.2 deliverable — the
            G3 declaration framework is still landing on the chain side.
            Today's setup ensures the slot is registered + the mnemonic
            is in your cold storage so you're ready when it does.
          </div>
        </div>
      )}
    </div>
  );
}

const triggerBtn: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.02)",
  color: "var(--fg-300)",
  fontFamily: "var(--f-sans)",
  fontSize: 11,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
};

const panel: CSSProperties = {
  marginTop: 8,
  padding: 10,
  borderRadius: 8,
  background: "rgba(124,127,255,0.04)",
  border: "1px solid var(--fg-700)",
};

const listStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 11,
  color: "var(--fg-300)",
  lineHeight: 1.55,
};
