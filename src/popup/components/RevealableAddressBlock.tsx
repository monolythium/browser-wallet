// Dual-format address block with the 0x form gated behind a
// reveal-confirm warning per whitepaper §22.7.
//
// Default state shows only the canonical mono1 form plus a small
// "Show 0x format" link. Tapping the link opens an inline yellow
// warning panel that names the cross-chain-confusion risk directly:
// the same 0x... shape on MetaMask is NOT the same key on Mono, and
// funds sent to a Mono 0x address from a foreign EVM wallet are
// permanently lost (Mono's chain admission rejects secp256k1
// signatures, §15). Only after the user confirms does the 0x line
// render with its own copy + Hide.
//
// State is per-instance / per-popup-session — closing the popup or
// navigating between screens resets to default. By design: the
// warning is the safety mechanism, so each fresh look at the 0x
// form re-shows the framing the whitepaper mandates.

import { useState } from "react";
import type { MouseEvent } from "react";

import { AddressLine } from "./AddressLine";

type RevealState = "default" | "warning" | "revealed";

export interface RevealableAddressBlockProps {
  /** Raw 0x-shaped wire address. AddressLine handles non-0x demo
   *  strings gracefully via bech32mDisplay's pass-through. */
  addr0x: string;
}

export function RevealableAddressBlock({ addr0x }: RevealableAddressBlockProps) {
  const [state, setState] = useState<RevealState>("default");

  const handleShowWarning = (e: MouseEvent) => {
    e.stopPropagation();
    setState("warning");
  };

  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation();
    setState("default");
  };

  const handleReveal = (e: MouseEvent) => {
    e.stopPropagation();
    setState("revealed");
  };

  const handleHide = (e: MouseEvent) => {
    e.stopPropagation();
    setState("default");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <AddressLine addr0x={addr0x} format="bech32m" />

      {state === "revealed" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <AddressLine addr0x={addr0x} format="hex" />
          </div>
          <button
            onClick={handleHide}
            style={{
              padding: "2px 6px",
              background: "transparent",
              border: "none",
              color: "var(--fg-400)",
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Hide
          </button>
        </div>
      )}

      {state === "default" && (
        <button
          onClick={handleShowWarning}
          style={{
            alignSelf: "flex-start",
            padding: "2px 0",
            background: "transparent",
            border: "none",
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            letterSpacing: "0.04em",
            cursor: "pointer",
          }}
        >
          Show 0x format ▾
        </button>
      )}

      {state === "warning" && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
            color: "var(--fg-100)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "rgba(242,180,65,1)",
            }}
          >
            <span aria-hidden="true">⚠</span>
            Show 0x hex format
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.55 }}>
            Mono addresses look identical to Ethereum / MetaMask
            addresses in 0x format, but they are NOT compatible. Sending
            Mono funds to a 0x address from MetaMask or another EVM
            wallet results in PERMANENT LOSS — no key on the other
            wallet can sign for them. Only reveal the 0x format if you
            understand this risk.
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 2,
            }}
          >
            <button
              onClick={handleCancel}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid var(--fg-700)",
                background: "transparent",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 11.5,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleReveal}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid var(--gold, rgba(242,180,65,0.6))",
                background: "rgba(242,180,65,0.18)",
                color: "var(--gold, rgba(242,180,65,1))",
                fontFamily: "var(--f-sans)",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reveal 0x format
            </button>
          </div>
        </div>
      )}
    </div>
  );
}