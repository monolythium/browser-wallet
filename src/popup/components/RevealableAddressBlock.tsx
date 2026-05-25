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

export interface RevealableAddressBlockProps {
  /** Raw 0x-shaped wire address. AddressLine handles non-0x demo
   *  strings gracefully via bech32mDisplay's pass-through. */
  addr0x: string;
  /** §22.7 address-kind discriminator. Defaults to `"eoa"` for the
   *  user-account case which is by far the most common consumer. */
  kind?: AddressKind;
}

export function RevealableAddressBlock({
  addr0x,
  kind = "eoa",
}: RevealableAddressBlockProps) {
  const [copied, setCopied] = useState(false);

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
