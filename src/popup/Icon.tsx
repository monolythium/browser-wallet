// Inline SVG icon set ported from designs/src/ext-popup.jsx (EIco).

import { addressToBech32m } from "../shared/bech32m.js";

export type IconName =
  | "send" | "qr" | "receive" | "stake" | "swap" | "chev" | "chev-d"
  | "check" | "close" | "back" | "settings" | "lock" | "eye" | "search"
  | "shield" | "warn" | "tpm" | "hw" | "passkey" | "face" | "bridge"
  | "contract" | "plus" | "more" | "pen" | "globe"
  | "menu" | "book" | "info" | "multisig" | "display"
  | "expand" | "copy" | "trash" | "external" | "bell";

interface IconProps {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16 }: IconProps) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (name) {
    case "send":
      return (
        <svg {...props}>
          <path d="M22 2 11 13" />
          <path d="M22 2l-7 20-4-9-9-4z" />
        </svg>
      );
    case "qr":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="3" height="3" />
          <rect x="18" y="18" width="3" height="3" />
        </svg>
      );
    case "receive":
      return (
        <svg {...props}>
          <path d="M12 5v14M5 12l7 7 7-7" />
        </svg>
      );
    case "stake":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <circle cx="5" cy="7" r="2" />
          <circle cx="19" cy="7" r="2" />
          <circle cx="5" cy="17" r="2" />
          <circle cx="19" cy="17" r="2" />
        </svg>
      );
    case "swap":
      return (
        <svg {...props}>
          <path d="M7 10h14l-4-4M17 14H3l4 4" />
        </svg>
      );
    case "chev":
      return (
        <svg {...props}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "chev-d":
      return (
        <svg {...props}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "check":
      return (
        <svg {...props}>
          <path d="m5 12 5 5L20 7" />
        </svg>
      );
    case "close":
      return (
        <svg {...props}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case "back":
      return (
        <svg {...props}>
          <path d="M15 18l-6-6 6-6" />
        </svg>
      );
    case "settings":
      // Proper gear/cog glyph (Feather-Icons-style).
      // Replaces the prior 4-spoke radial that didn't read as "gear"
      // at the 13 px top-bar size. Same 8-tooth shape MetaMask uses.
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "lock":
      return (
        <svg {...props}>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      );
    case "eye":
      return (
        <svg {...props}>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "search":
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "shield":
      return (
        <svg {...props}>
          <path d="M12 2 4 5v7c0 5 3.6 8.6 8 10 4.4-1.4 8-5 8-10V5l-8-3z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "warn":
      return (
        <svg {...props}>
          <path d="M12 2 2 21h20L12 2z" />
          <path d="M12 9v5M12 17h0" />
        </svg>
      );
    case "tpm":
      return (
        <svg {...props}>
          <rect x="4" y="7" width="16" height="13" rx="2" />
          <path d="M7 7V5a5 5 0 0 1 10 0v2" />
          <circle cx="12" cy="13" r="2" />
        </svg>
      );
    case "hw":
      return (
        <svg {...props}>
          <rect x="3" y="8" width="18" height="11" rx="2" />
          <path d="M7 8V5h10v3M12 13v4" />
        </svg>
      );
    case "passkey":
      return (
        <svg {...props}>
          <path d="M15 7a4 4 0 1 1-4 4M11 11l-7 7v3h3l7-7" />
        </svg>
      );
    case "face":
      return (
        <svg {...props} strokeWidth={1.5}>
          <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
          <circle cx="9" cy="11" r="0.8" fill="currentColor" />
          <circle cx="15" cy="11" r="0.8" fill="currentColor" />
          <path d="M9 15c.8 1 2 1.5 3 1.5S14.2 16 15 15" />
        </svg>
      );
    case "bridge":
      return (
        <svg {...props}>
          <path d="M2 17c2-4 4-4 6-4s3 4 8 4" />
          <path d="M2 13c2-4 4-4 6-4s4 4 8 4" />
        </svg>
      );
    case "contract":
      return (
        <svg {...props}>
          <path d="M5 3h11l4 4v14H5z" />
          <path d="M9 9h8M9 13h8M9 17h5" />
        </svg>
      );
    case "plus":
      return (
        <svg {...props}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "more":
      return (
        <svg {...props}>
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="19" cy="12" r="1.5" fill="currentColor" />
        </svg>
      );
    case "pen":
      return (
        <svg {...props}>
          <path d="M14.5 4.5l5 5L8 21H3v-5L14.5 4.5z" />
          <path d="M12.5 6.5l5 5" />
        </svg>
      );
    case "globe":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
        </svg>
      );
    case "menu":
      // Hamburger (3 horizontal lines) for the top-bar
      // menu trigger that replaces the previous lock button.
      return (
        <svg {...props}>
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      );
    case "book":
      // Address book (Contacts menu item).
      return (
        <svg {...props}>
          <path d="M4 4h14a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4z" />
          <path d="M4 18a2 2 0 0 1 2-2h14" />
        </svg>
      );
    case "info":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
    case "multisig":
      // Three overlapping circles for the multi-signer
      // / multisig wallet menu item. Reads as "group of signers."
      return (
        <svg {...props}>
          <circle cx="9" cy="10" r="3.2" />
          <circle cx="15" cy="10" r="3.2" />
          <circle cx="12" cy="15.5" r="3.2" />
        </svg>
      );
    case "display":
      // Display / window-mode toggle icon. Renders
      // as a monitor outline.
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      );
    case "expand":
      // Open-in-new-tab / fullscreen glyph
      // (Feather-style external-link with arrow + frame).
      return (
        <svg {...props}>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      );
    case "copy":
      // Feather-style two-rectangle clipboard glyph.
      return (
        <svg {...props}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "trash":
      // Feather-style trash glyph for the
      // hamburger-menu "Reset wallet" destructive entry.
      return (
        <svg {...props}>
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      );
    case "external":
      // ↗ up-right arrow — the "opens externally" affordance for inline
      // Monoscan links, companion to the globe used on the big CTA buttons.
      return (
        <svg {...props}>
          <line x1="7" y1="17" x2="17" y2="7" />
          <polyline points="8 7 17 7 17 16" />
        </svg>
      );
    case "bell":
      // Notifications row in the hamburger menu + future header
      // glyph. Bell silhouette + clapper line; matches the stroke-only
      // pattern of every other glyph (currentColor + strokeWidth 1.8).
      return (
        <svg {...props}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    default:
      return null;
  }
}

interface SparkProps {
  data: number[];
  color?: string;
  down?: boolean;
}

export function Spark({ data, color = "#7c7fff", down = false }: SparkProps) {
  if (!data || data.length === 0) return null;
  const w = 44;
  const h = 16;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const xs = (i: number) => (i / (data.length - 1)) * w;
  const ys = (v: number) => h - ((v - min) / (max - min || 1)) * (h - 2) - 1;
  const d = data
    .map((v, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`)
    .join(" ");
  const c = down ? "#ff8a9a" : color;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d} fill="none" stroke={c} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function fmt(n: number | null | undefined, dp = 2): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function shortAddr(addr: string | undefined, n = 8): string {
  if (!addr) return "—";
  const t = addr.split(":");
  if (t.length >= 3) {
    const last = t[t.length - 1] ?? "";
    return `${t[0]}:${t[1]}…${last}`;
  }
  // Whitepaper §22.7 — hex `0x…` is not a valid display format. Convert
  // raw 20-byte EVM-shaped addresses to bech32m before truncating so any
  // caller that hands us a wire-format address gets the canonical
  // user-facing form. Non-0x inputs (already-bech32m, demo strings, tx
  // hashes) pass through untouched and slice as before.
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    try {
      addr = addressToBech32m(addr);
    } catch {
      // fall through — surface the original string rather than swallow.
    }
  }
  return addr.slice(0, n) + "…" + addr.slice(-4);
}
