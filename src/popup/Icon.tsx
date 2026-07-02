// Inline SVG icon set ported from designs/src/ext-popup.jsx (EIco).

import { addressToBech32m } from "../shared/bech32m.js";

export type IconName =
  | "send" | "receive" | "stake" | "swap" | "chev" | "chev-d"
  | "check" | "clock" | "close" | "back" | "settings" | "lock" | "eye" | "search"
  | "shield" | "warn" | "tpm" | "hw" | "passkey" | "bridge"
  | "contract" | "plus" | "more" | "pen" | "globe"
  | "menu" | "book" | "info" | "multisig" | "display"
  | "expand" | "copy" | "trash" | "external" | "bell" | "contrast" | "code"
  | "contacts" | "network" | "sliders" | "server" | "gem"
  | "mono-mark" | "github" | "grid"
  | "language" | "coins" | "palette" | "unstake" | "restake" | "reward";

/** Distinct glyph per delegation action so delegate / undelegate / redelegate
 *  read apart at a glance (they all shared `stake` before). delegate keeps the
 *  cluster `stake` glyph; undelegate gets the `unstake` (node releasing down);
 *  redelegate gets `restake` (the same cluster with a ↔ arrow at its center —
 *  stake moving between clusters). A failed record inherits the glyph in the
 *  error tone via NotificationRow's status ring. */
export function iconForDelegationKind(
  kind: "delegate" | "undelegate" | "redelegate",
): IconName {
  switch (kind) {
    case "delegate":
      return "stake";
    case "undelegate":
      return "unstake";
    case "redelegate":
      return "restake";
  }
}

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
    case "language":
      // Latin "A" stroke crossing a CJK character — language / locale.
      return (
        <svg {...props}>
          <path d="m5 8 6 6" />
          <path d="m4 14 6-6 2-3" />
          <path d="M2 5h12" />
          <path d="M7 2h1" />
          <path d="m22 22-5-10-5 10" />
          <path d="M14 18h6" />
        </svg>
      );
    case "coins":
      // Two overlapping coins — display currency / money.
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="6" />
          <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
          <path d="M7 6h1v4" />
          <path d="m16.71 13.88.7.71-2.82 2.82" />
        </svg>
      );
    case "reward":
      // Gift box (lid + ribbon + bow) — a claimed staking reward. Distinct from
      // `receive` (plain ↓), `coins` (two coins), and `gem`.
      return (
        <svg {...props}>
          <rect x="3" y="8" width="18" height="4" rx="1" />
          <path d="M5 12v9h14v-9" />
          <path d="M12 8v13" />
          <path d="M12 8a3 3 0 1 1 4 0M12 8a3 3 0 1 0-4 0" />
        </svg>
      );
    case "palette":
      // Artist palette with colour wells — the Display & Preferences hub.
      // A deliberately distinct glyph (not the gear / sliders / contrast
      // used elsewhere). The wells are filled dots, so override the shared
      // stroke styling on those circles.
      return (
        <svg {...props}>
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2Z" />
          <circle cx="8.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="13.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="6.5" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "send":
      return (
        <svg {...props}>
          <path d="M22 2 11 13" />
          <path d="M22 2l-7 20-4-9-9-4z" />
        </svg>
      );
    case "clock":
      // Clock — pending / awaiting confirmation.
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "code":
      // `</>` developer glyph — code brackets + slash.
      return (
        <svg {...props}>
          <path d="m18 16 4-4-4-4" />
          <path d="m6 8-4 4 4 4" />
          <path d="m14.5 4-5 16" />
        </svg>
      );
    case "contacts":
      // Two people — Contacts.
      return (
        <svg {...props}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "network":
      // Connected nodes — Networks.
      return (
        <svg {...props}>
          <circle cx="12" cy="5" r="2.5" />
          <circle cx="5" cy="19" r="2.5" />
          <circle cx="19" cy="19" r="2.5" />
          <path d="M10.7 7.1 6.3 16.9M13.3 7.1l4.4 9.8M7.5 19h9" />
        </svg>
      );
    case "sliders":
      // Adjustment sliders — Features (advanced surfaces).
      return (
        <svg {...props}>
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
      );
    case "server":
      // Stacked server racks — Operators (network nodes).
      return (
        <svg {...props}>
          <rect x="2" y="3" width="20" height="8" rx="2" />
          <rect x="2" y="13" width="20" height="8" rx="2" />
          <line x1="6" y1="7" x2="6.01" y2="7" />
          <line x1="6" y1="17" x2="6.01" y2="17" />
        </svg>
      );
    case "gem":
      // Faceted gem — Why Monolythium (brand / value).
      return (
        <svg {...props}>
          <path d="M6 3h12l4 6-10 12L2 9 6 3z" />
          <path d="M2 9h20" />
          <path d="m9.5 9 2.5 12 2.5-12L12 3" />
        </svg>
      );
    case "github":
      // GitHub mark (Octocat silhouette) — repo link. Fill glyph in the
      // shared 24×24 box; overrides the set-wide stroke.
      return (
        <svg {...props} fill="currentColor" stroke="none">
          <path d="M12 .5C5.73.5.5 5.73.5 12.18c0 5.16 3.35 9.53 7.99 11.08.58.11.8-.25.8-.56 0-.28-.01-1.02-.02-2-3.25.71-3.94-1.57-3.94-1.57-.53-1.35-1.3-1.71-1.3-1.71-1.06-.73.08-.71.08-.71 1.17.08 1.79 1.21 1.79 1.21 1.04 1.79 2.73 1.27 3.4.97.11-.76.41-1.27.74-1.56-2.6-.3-5.33-1.3-5.33-5.79 0-1.28.46-2.32 1.21-3.14-.12-.3-.52-1.49.11-3.11 0 0 .99-.32 3.23 1.2a11.2 11.2 0 0 1 5.88 0c2.24-1.52 3.22-1.2 3.22-1.2.64 1.62.24 2.81.12 3.11.76.82 1.21 1.86 1.21 3.14 0 4.5-2.74 5.49-5.35 5.78.42.36.8 1.08.8 2.18 0 1.58-.01 2.85-.01 3.24 0 .31.21.68.81.56 4.64-1.55 7.98-5.92 7.98-11.08C23.5 5.73 18.27.5 12 .5z" />
        </svg>
      );
    case "mono-mark":
      // Monolythium "M" brand mark (isometric folded-ribbon) — mirrors
      // M_MARK in components/WalletLogo.tsx. Fill glyph in the brand's own
      // 23 23 185 185 box; color comes from the wrapping element (brand
      // purple for Monolythium, teal for Mono Labs).
      return (
        <svg {...props} viewBox="23 23 185 185" fill="currentColor" stroke="none">
          <path d="M52 31 L79 46 L54 60 L54 199 L31 186 L31 43 Z M178 31 L200 43 L200 186 L176 200 L176 61 L117 93 L64 65 L89 51 L116 66 Z M79 103 L103 116 L103 186 L80 199 Z M150 103 L151 199 L128 186 L128 116 Z" />
        </svg>
      );
    case "grid":
      // 2×2 app tiles — Ecosystem (a collection of connected projects).
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
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
    case "unstake":
      // The `stake` cluster releasing its center weight downward — undelegate.
      // Mirrors delegate's `stake` glyph (the same 4 satellites) so the pair
      // reads as opposites; the center is a down arrow (weight leaving) instead
      // of the staked node.
      return (
        <svg {...props}>
          <circle cx="5" cy="7" r="2" />
          <circle cx="19" cy="7" r="2" />
          <circle cx="5" cy="17" r="2" />
          <circle cx="19" cy="17" r="2" />
          <path d="M12 7v8M9 13l3 3 3-3" />
        </svg>
      );
    case "restake":
      // The `stake` cluster with a left-right arrow at its center — redelegate
      // (stake moving between clusters). Mirrors delegate's `stake` glyph (the
      // same 4 satellites) so delegate / undelegate / redelegate read as a
      // family; the center is a bidirectional ↔ arrow instead of the staked
      // node (stake) or the down arrow (unstake).
      return (
        <svg {...props}>
          <circle cx="5" cy="7" r="2" />
          <circle cx="19" cy="7" r="2" />
          <circle cx="5" cy="17" r="2" />
          <circle cx="19" cy="17" r="2" />
          <path d="M8 12h8M11 9l-3 3 3 3M13 9l3 3-3 3" />
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
    case "contrast":
      // Half-filled circle — the canonical light/dark "theme / appearance"
      // glyph. Used by the Settings "Theme" category card and the hamburger
      // "Theme" entry. The filled right half overrides the set-wide
      // fill:none; the circle outline still uses the shared stroke.
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

export function fmt(n: number | null | undefined, dp = 2): string {
  if (n == null) return "—";
  // Truncate toward zero — NEVER round a token balance up. toLocaleString
  // rounds, so a 99.9998 balance rendered at 2dp came out as "100.00",
  // overstating funds and disagreeing with the Send screen (which truncates
  // via lythoshiToLythDecimal). Floor to `dp` places first, then format; the
  // final toLocaleString only cleans up sub-dp float noise, it can't push the
  // value back above the truncated amount.
  const factor = 10 ** dp;
  const truncated = Math.trunc(n * factor) / factor;
  return truncated.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
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
