// Opt-in developer-mode toggle row — an accessible slide switch + a
// guarded confirm popup. Mounted at the top of the hamburger menu,
// Settings, and About. Developer mode reveals technical surfaces (raw
// hashes, RPC method names, error codes, the RISC-V console) that are
// hidden by default for everyday users.
//
// Single source of truth: the switch state is driven purely by
// `useFeature("DEVELOPER_MODE")` — no separate local on/off state.
// Turning ON requires confirming the popup; turning OFF is immediate
// (no confirm). All three placements stay in sync via the
// chrome.storage onChanged subscription inside useFeature.

import { useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { Modal } from "./Modal";
import { useFeature } from "../hooks/useFeature";
import { bgTwoTierSetFeature } from "../bg";

interface DeveloperModeToggleProps {
  /** Optional spacing/layout override per placement. The icon / label /
   *  switch / popup behavior is identical everywhere. */
  style?: CSSProperties;
  className?: string;
}

export function DeveloperModeToggle({
  style,
  className,
}: DeveloperModeToggleProps) {
  const devMode = useFeature("DEVELOPER_MODE");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // OFF -> open the confirm popup (do NOT flip yet). ON -> flip off
  // immediately, no confirm. The switch animates when useFeature
  // re-renders after the write lands. A native <button> handles
  // Enter / Space, so role="switch" is keyboard-operable for free.
  const onActivate = () => {
    if (devMode) {
      void bgTwoTierSetFeature("DEVELOPER_MODE", false);
    } else {
      setConfirmOpen(true);
    }
  };

  const onConfirmEnable = () => {
    void bgTwoTierSetFeature("DEVELOPER_MODE", true);
    setConfirmOpen(false);
  };

  return (
    <>
      <div className={className} style={{ ...rowStyle, ...style }}>
        <span style={iconWrapStyle}>
          <Icon name="code" size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={labelStyle}>Developer mode</div>
          <div style={sublabelStyle}>
            Show technical details, raw values, and developer tools
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={devMode}
          aria-label="Developer mode"
          onClick={onActivate}
          style={{
            ...trackStyle,
            background: devMode ? "var(--gold)" : "var(--fg-700)",
          }}
        >
          <span
            style={{
              ...knobStyle,
              transform: devMode ? "translateX(18px)" : "translateX(0)",
            }}
          />
        </button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={
          <>
            <Icon name="warn" size={12} /> Enable developer mode?
          </>
        }
        titleAccent="var(--gold)"
      >
        <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--fg-200)" }}>
          Developer mode reveals technical surfaces meant for developers — raw
          RPC endpoints, chain and genesis hashes, SDK and runtime build
          details, error codes, and the RISC-V contract console. None of this is
          needed for everyday use, and some of it is easy to misread. Turn it on
          only if you know what you're looking for.
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginTop: 6,
          }}
        >
          <button onClick={() => setConfirmOpen(false)} style={cancelStyle}>
            Cancel
          </button>
          <button onClick={onConfirmEnable} style={enableStyle}>
            Enable developer mode
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

// Minimal accessible slide-switch — there is no existing switch component
// to reuse (the Features page uses an On/Off pill). Track + knob with a
// smooth left->right knob transition; checked state comes from useFeature.
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

// Gold-accent primary to signal caution (not a destructive red).
const enableStyle: CSSProperties = {
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
