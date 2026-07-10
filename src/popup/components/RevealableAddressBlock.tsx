// Bech32m address block with inline copy. Per whitepaper §22.7 hex
// `0x…` is not a valid format anywhere user-facing in v4.1 — wallets
// emit and accept bech32m exclusively, so this component renders only
// the bech32m form and offers no 0x reveal. The 0x bytes still live in
// chrome.storage as the chain-wire form; the display layer always
// converts via `bech32mDisplay`.
//
// The name "Revealable" is preserved for diff continuity; the
// component is now a plain bech32m block with copy. A rename can land
// in the Phase-9 legacy cleanup.

import { useState } from "react";
import type { MouseEvent } from "react";

import { AddressLine, CheckIcon, ClipboardIcon } from "./AddressLine";
import { bech32mDisplay, type AddressKind } from "../../shared/bech32m";
import { useReverseName } from "../hooks/useReverseName";

export interface RevealableAddressBlockProps {
  /** Raw 0x-shaped wire address. AddressLine handles non-0x demo
   *  strings gracefully via bech32mDisplay's pass-through. */
  addr0x: string;
  /** §22.7 address-kind discriminator. Defaults to `"eoa"` for the
   *  user-account case which is by far the most common consumer. */
  kind?: AddressKind;
  /** When set, the block quorum-reverse-resolves the address and shows its
   *  canonical `*.mono` name above the bech32m string (the address stays the
   *  source of truth). Omit to skip name resolution. */
  chainIdHex?: string;
}

export function RevealableAddressBlock({
  addr0x,
  kind = "eoa",
  chainIdHex,
}: RevealableAddressBlockProps) {
  const [copied, setCopied] = useState(false);
  // §22.8 reverse name (quorum-checked); null → show only the address.
  const monoName = useReverseName(
    chainIdHex !== undefined ? addr0x : null,
    chainIdHex ?? null,
  );

  const handleCopyBech32m = (e: MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(bech32mDisplay(addr0x, kind)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {monoName !== null && (
        <div
          style={{
            fontFamily: "var(--f-sans)",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--gold)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          title="Canonical .mono name (verified across operators)"
        >
          <span>{monoName}</span>
          <span
            style={{
              fontSize: 8.5,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--fg-400)",
              border: "1px solid var(--fg-700)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            name
          </span>
        </div>
      )}
      <AddressLine
        addr0x={addr0x}
        kind={kind}
        truncate={false}
        inlineCopy={false}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={handleCopyBech32m}
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
          }}
        >
          {copied ? <CheckIcon /> : <ClipboardIcon />}
        </button>
      </div>
    </div>
  );
}
