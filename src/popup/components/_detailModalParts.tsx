// Shared parts for detail-style modals (`ActivityDetail`, the upcoming
// `NotificationDetail`, and any future "tap a row → see structured
// detail" surface). Extracted from `ActivityDetail.tsx` with zero
// behavior change so the existing activity tests stay green; the
// generic shape (DRow / CopyableAddress / MonoscanTxButton / truncMiddle
// / relativeMs) lets each caller stay typed to its own row shape rather
// than turning ActivityDetail into a polymorphic monster.
//
// The leading underscore in the filename is the project's convention
// for shared internal building blocks that are NOT a page in their own
// right.

import { useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../Icon";
import { ExternalLink } from "./ExternalLink";
import { CheckIcon, ClipboardIcon } from "./AddressLine";
import { bech32mDisplay } from "../../shared/bech32m";
import { monoscanAddressUrl, monoscanTxUrl } from "../../shared/build-info";

/** Middle-truncate any string (bech32m address or hash) for compact
 *  display. Pure — never throws. */
export function truncMiddle(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** Relative timestamp ("Ns / Nm / Nh ago"). Bounded — beyond a few
 *  hours the absolute date is more informative; callers that need
 *  finer granularity pass `Date(...).toLocaleString(...)` explicitly. */
export function relativeMs(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

/** Two-column label/value row, monospace, used inside any detail modal. */
export function DRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "6px 0",
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 11,
          color: "var(--fg-100)",
          textAlign: "right",
          wordBreak: "break-all",
          minWidth: 0,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** "View on Monoscan" CTA → the tx page. Globe glyph, matching the
 *  receipts language elsewhere in the wallet. */
export function MonoscanTxButton({ hash }: { hash: string }) {
  return (
    <a
      href={monoscanTxUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="ext-act"
      style={{
        width: "100%",
        padding: "10px",
        marginTop: 12,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        textDecoration: "none",
      }}
    >
      <Icon name="globe" size={13} /> View on Monoscan
    </a>
  );
}

/** Truncated address → Monoscan address page, with a copy button.
 *  Accepts a 0x address (own wallet) or an already-bech32m counterparty —
 *  both via the SAFE `bech32mDisplay` (the strict
 *  `shortBech32m`/`addressToBech32m` path throws on non-0x input and
 *  previously crashed the activity view via the ErrorBoundary).
 *  Renders the registered/contact name when present. */
export function CopyableAddress({
  addr0x,
  name,
}: {
  addr0x: string;
  name?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const full = bech32mDisplay(addr0x);
  const short = truncMiddle(full);
  const onCopy = () => {
    void navigator.clipboard.writeText(full).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 2,
      }}
    >
      {name && (
        <span style={{ fontFamily: "var(--f-sans)", fontWeight: 600, color: "var(--fg-100)" }}>
          {name}
        </span>
      )}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <ExternalLink href={monoscanAddressUrl(full)} title={full} style={{ fontFamily: "var(--f-mono)" }}>
          {short}
        </ExternalLink>
        <button
          onClick={onCopy}
          aria-label="Copy address"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            padding: 0,
            background: "transparent",
            border: "none",
            color: copied ? "var(--ok, #5fc97a)" : "var(--fg-400)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {copied ? <CheckIcon /> : <ClipboardIcon />}
        </button>
      </span>
    </div>
  );
}
