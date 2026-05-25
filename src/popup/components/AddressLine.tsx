// Compact address line — renders a bech32m address with per-line copy
// icon. Tapping the address text toggles truncated/expanded form, tapping
// the icon copies the full bech32m string.
//
// Per whitepaper §22.7 the hex `0x…` form is not a valid display format
// at any chain-facing wallet surface, so this component renders only
// bech32m. Wire storage stays 0x — `addr0x` is the EVM-shaped raw bytes
// — and the component derives the bech32m form via `bech32mDisplay` so
// demo strings (pre-keystore-patch) and malformed input don't throw.

import { useState } from "react";
import type { CSSProperties, MouseEvent } from "react";

import { bech32mDisplay, type AddressKind } from "../../shared/bech32m";

export interface AddressLineProps {
  /** Raw 0x-shaped wire address. May briefly be a demo non-0x string
   *  before the keystore patch fires; the component handles both. */
  addr0x: string;
  /** §22.7 address kind for the HRP discriminator. Defaults to "eoa"
   *  (HRP `mono`) which is correct for user-account display. Use
   *  `"multisig"`, `"cluster"`, `"contract"`, etc. when the call site
   *  knows the address is non-EOA. */
  kind?: AddressKind;
  /** When false, render the full address (no first-N + … + last-N collapse).
   *  Tap-to-expand still works either way. Default true. */
  truncate?: boolean;
  /** Override the default first-6 + … + last-4 truncation. */
  truncatePrefix?: number;
  truncateSuffix?: number;
  /** When false, the inline copy icon is omitted so the address claims the
   *  full row width. Caller renders its own copy affordance. Default true. */
  inlineCopy?: boolean;
  /** Outer wrapper style hook for parents that need to tighten gaps. */
  style?: CSSProperties;
}

export function AddressLine({
  addr0x,
  kind = "eoa",
  truncate = true,
  truncatePrefix = 6,
  truncateSuffix = 4,
  inlineCopy = true,
  style,
}: AddressLineProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fullText = bech32mDisplay(addr0x, kind);
  const display =
    !truncate || expanded || fullText.length <= truncatePrefix + truncateSuffix + 1
      ? fullText
      : `${fullText.slice(0, truncatePrefix)}…${fullText.slice(-truncateSuffix)}`;

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(fullText).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // navigator.clipboard can fail in restricted contexts; fail quiet.
      },
    );
  };

  const handleToggleExpand = (e: MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        ...style,
      }}
    >
      <span
        onClick={handleToggleExpand}
        title={expanded ? "Tap to truncate" : "Tap to show full address"}
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 11,
          color: "var(--fg-100)",
          cursor: "pointer",
          flex: 1,
          wordBreak: "break-all",
          userSelect: "all",
        }}
      >
        {display}
      </span>
      {inlineCopy && (
        <button
          onClick={handleCopy}
          aria-label="Copy bech32m address"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
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
      )}
    </div>
  );
}

export function ClipboardIcon() {
  // Two overlapping rounded squares — the standard "copy" glyph.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="5"
        y="2"
        width="9"
        height="9"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="2"
        y="5"
        width="9"
        height="9"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="var(--bg-base, transparent)"
      />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3.5 8.5l3 3 6-6.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}