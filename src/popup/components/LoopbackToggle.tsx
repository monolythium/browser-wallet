// Opt-in for dialling a node on this machine (the P6-001 loopback re-open).
//
// Mounted in the Operators editor, which is already developer-mode gated. It is
// its OWN flag: enabling developer mode must not enable this. Two deliberate
// acts across two surfaces is the property that defeats "go to settings and
// paste this URL" — the social attack is the only thing this opt-in closes.
//
// IT IS NOT A SECURITY BOUNDARY. The loopback `connect-src` entries ship to
// every user whether or not this is on; a CSP is a static manifest directive
// with no runtime API to widen it. What this decides is whether the WALLET will
// dial such a host. Copy in this file must never imply otherwise.
//
// The affordance deliberately mirrors DeveloperModeToggle: the same row shape,
// the same accessible slide switch, the same gold-accent modal — gold to signal
// caution, never the destructive red, because nothing here is destroyed. Turning
// OFF is immediate; turning ON costs a warning, a Continue, and a typed word.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { Modal } from "./Modal";
import { LOOPBACK_CONFIRM_WORD } from "../../shared/constants";
import { STORAGE_KEY_LOOPBACK_ALLOWED } from "../../shared/loopback";
import { confirmWordMatches } from "./ConfirmWordDialog";

type Phase = "warn" | "confirm";

/** Read + subscribe to the opt-in. `chrome.storage.local` is the source of
 *  truth; the SW's onChanged listener re-runs its dial-set off the same event,
 *  so the popup and the background can never disagree about it. */
function useLoopbackAllowed(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get([STORAGE_KEY_LOOPBACK_ALLOWED], (res) => {
      if (!cancelled) setOn(res?.[STORAGE_KEY_LOOPBACK_ALLOWED] === true);
    });
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEY_LOOPBACK_ALLOWED];
      if (change) setOn(change.newValue === true);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);
  return on;
}

export function LoopbackToggle({ style }: { style?: CSSProperties }) {
  const allowed = useLoopbackAllowed();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [typed, setTyped] = useState("");

  const close = () => {
    setPhase(null);
    setTyped("");
  };

  const onActivate = () => {
    if (allowed) {
      // Off is immediate: withdrawing permission should never be gated.
      void chrome.storage.local.set({ [STORAGE_KEY_LOOPBACK_ALLOWED]: false });
      return;
    }
    setPhase("warn");
  };

  const confirmOn = () => {
    if (!confirmWordMatches(typed, LOOPBACK_CONFIRM_WORD)) return;
    void chrome.storage.local.set({ [STORAGE_KEY_LOOPBACK_ALLOWED]: true });
    close();
  };

  const matched = confirmWordMatches(typed, LOOPBACK_CONFIRM_WORD);

  return (
    <>
      <div style={{ ...rowStyle, ...style }}>
        <span style={iconWrapStyle}>
          <Icon name="code" size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={labelStyle}>Allow a local node</div>
          <div style={sublabelStyle}>
            Let this wallet connect to a node running on this computer.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowed}
          aria-label="Allow a local node"
          onClick={onActivate}
          style={{
            ...trackStyle,
            background: allowed ? "var(--gold)" : "var(--fg-700)",
          }}
        >
          <span
            style={{
              ...knobStyle,
              transform: allowed ? "translateX(18px)" : "translateX(0)",
            }}
          />
        </button>
      </div>

      <Modal
        open={phase === "warn"}
        onClose={close}
        title={
          <>
            <Icon name="warn" size={12} /> Connecting to a local node
          </>
        }
        titleAccent="var(--gold)"
      >
        <div style={bodyStyle}>
          <div style={headingStyle}>What this changes</div>
          <p style={paraStyle}>
            Right now this wallet only talks to the operators it ships with.
            Turning this on lets you point it at a node running on this computer
            — 127.0.0.1, [::1] or localhost, on any port.
          </p>
          <p style={paraStyle}>
            That is the only thing it allows. The wallet still cannot be pointed
            at a server on the internet.
          </p>

          <div style={headingStyle}>What you&apos;re trusting</div>
          <p style={paraStyle}>
            Everything the wallet shows you about the network comes from whatever
            you point it at: your balance, your history, and whether a
            transaction was accepted.
          </p>
          <p style={paraStyle}>
            The wallet cannot tell a good node from a bad one. It checks that the
            node reports the network and genesis it expects, and after that it
            believes what it is told.
          </p>

          <div style={headingStyle}>What can go wrong</div>
          <ul style={listStyle}>
            <li>Your balance and history can be wrong, or quietly out of date.</li>
            <li>A transaction can be accepted by the node and never reach the network.</li>
            <li>
              The node can quote a fee far above the real one — the wallet caps
              what it will sign, but that cap is generous.
            </li>
            <li>
              The node sees every transaction you sign, and the address behind
              it. Transactions are submitted unencrypted.
            </li>
          </ul>

          <div style={headingStyle}>What still can&apos;t happen</div>
          <ul style={listStyle}>
            <li>
              Your recovery phrase and your keys never leave this device. A node
              never sees them.
            </li>
            <li>
              A node cannot change where your funds go. The recipient and the
              amount are chosen here and signed here.
            </li>
            {/* "every time it connects" would over-claim: a PASSING genesis
                verdict is cached for GENESIS_POSITIVE_TTL_MS (networks.ts:521),
                so the wallet trusts a check up to a minute old rather than
                re-probing on each connection. A definitive MISMATCH is sticky
                forever (:520), so the refusal half is fully true and the verdict
                is unchanged — only the frequency claim is corrected. */}
            <li>
              A node cannot move you to a different network. The wallet checks
              the network&apos;s identity when it connects, and refuses if it
              doesn&apos;t match.
            </li>
          </ul>

          <div style={headingStyle}>If you&apos;re not sure</div>
          <p style={paraStyle}>
            Leave this off. Nothing in the wallet is limited without it — this
            only matters if you are running a node yourself.
          </p>
        </div>
        <div style={actionsStyle}>
          <button onClick={close} style={cancelStyle}>
            Cancel
          </button>
          <button onClick={() => setPhase("confirm")} style={primaryStyle}>
            Continue
          </button>
        </div>
      </Modal>

      <Modal
        open={phase === "confirm"}
        onClose={close}
        title={
          <>
            <Icon name="warn" size={12} /> Allow a local node
          </>
        }
        titleAccent="var(--gold)"
      >
        <div style={bodyStyle}>
          <p style={paraStyle}>
            Type {LOOPBACK_CONFIRM_WORD} to allow a local node.
          </p>
          <p style={paraStyle}>This stays on until you turn it off.</p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label={`Type ${LOOPBACK_CONFIRM_WORD} to confirm`}
            autoComplete="off"
            spellCheck={false}
            style={inputStyle}
          />
        </div>
        <div style={actionsStyle}>
          <button onClick={() => setPhase("warn")} style={cancelStyle}>
            Back
          </button>
          <button
            onClick={confirmOn}
            disabled={!matched}
            style={{ ...primaryStyle, opacity: matched ? 1 : 0.5 }}
          >
            Confirm
          </button>
        </div>
      </Modal>
    </>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
};

const iconWrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  color: "var(--fg-300)",
  flexShrink: 0,
};

const labelStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--fg-100)",
};

const sublabelStyle: CSSProperties = {
  fontSize: 10.5,
  color: "var(--fg-400)",
  marginTop: 3,
  lineHeight: 1.4,
};

const trackStyle: CSSProperties = {
  position: "relative",
  width: 40,
  height: 22,
  borderRadius: 11,
  border: "none",
  padding: 0,
  cursor: "pointer",
  flexShrink: 0,
  transition: "background 150ms var(--e-out, ease)",
};

const knobStyle: CSSProperties = {
  position: "absolute",
  top: 3,
  left: 3,
  width: 16,
  height: 16,
  borderRadius: "50%",
  background: "#fff",
  boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
  transition: "transform 160ms var(--e-out, ease)",
};

const bodyStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-200)",
};

// Section headings render at the weight of other section headings on the page,
// so the warning reads as structure rather than a wall of body text.
const headingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--fg-100)",
  marginTop: 12,
  marginBottom: 4,
};

const paraStyle: CSSProperties = { margin: "0 0 6px" };

const listStyle: CSSProperties = {
  margin: "0 0 6px",
  paddingLeft: 16,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const inputStyle: CSSProperties = {
  width: "100%",
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 12,
};

const actionsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
  marginTop: 10,
};

const cancelStyle: CSSProperties = {
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

// Gold-accent primary to signal caution — deliberately not a destructive red,
// matching DeveloperModeToggle. Nothing here is destroyed.
const primaryStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg, rgba(212,160,60,0.12))",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
