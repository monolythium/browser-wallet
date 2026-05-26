// Inline SVG icon set ported from designs/src/ext-popup.jsx (EIco).

import { addressToBech32m } from "../shared/bech32m.js";

export type IconName =
  | "send" | "qr" | "receive" | "stake" | "swap" | "chev" | "chev-d"
  | "check" | "close" | "back" | "settings" | "lock" | "eye" | "search"
  | "shield" | "warn" | "tpm" | "hw" | "passkey" | "face" | "bridge"
  | "contract" | "plus" | "more" | "pen" | "globe";

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
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4 12H2M22 12h-2" />
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
