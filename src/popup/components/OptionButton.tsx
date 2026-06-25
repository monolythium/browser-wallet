// OptionButton — a single choosable option in a preference picker.
// Reuses the active-gold styling used across the wallet's pickers so
// language / currency grids read consistently with the theme swatches.

import type { ReactNode } from "react";

export interface OptionButtonProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}

export function OptionButton({ active, onClick, children }: OptionButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        border: active ? "1px solid var(--gold)" : "1px solid var(--fg-700)",
        background: active ? "var(--gold-bg)" : "rgba(255,255,255,0.04)",
        color: active ? "var(--gold)" : "var(--fg-100)",
        fontFamily: "var(--f-sans)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        transition: "all 150ms var(--e-out)",
        textAlign: "left",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}
