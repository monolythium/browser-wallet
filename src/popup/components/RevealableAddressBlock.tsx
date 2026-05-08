// Dual-format address block with the 0x form gated behind a
// reveal-confirm warning per whitepaper §22.7.
//
// Default state shows only the canonical mono1 form plus a small
// "Show 0x format" link. Tapping the link opens a modal warning panel
// that names the cross-chain-confusion risk directly: the same 0x...
// shape on MetaMask is NOT the same key on Mono, and funds sent to a
// Mono 0x address from a foreign EVM wallet are permanently lost
// (Mono's chain admission rejects secp256k1 signatures, §15). Only
// after the user confirms does the 0x line render — also inside the
// modal — with its own copy + Hide button.
//
// State is per-instance / per-popup-session — closing the popup or
// navigating between screens resets to default. By design: the
// warning is the safety mechanism, so each fresh look at the 0x
// form re-shows the framing the whitepaper mandates.
//
// The modal pattern (vs the previous inline accordion) keeps the
// surrounding layout — Home Top in particular, with its 380 px
// popup-width constraint — anchored while the user reads the warning.

import { useState } from "react";
import type { MouseEvent } from "react";

import { AddressLine, CheckIcon, ClipboardIcon } from "./AddressLine";
import { Modal } from "./Modal";
import { bech32mDisplay } from "../../shared/bech32m";

type RevealState = "closed" | "warning" | "revealed";

export interface RevealableAddressBlockProps {
  /** Raw 0x-shaped wire address. AddressLine handles non-0x demo
   *  strings gracefully via bech32mDisplay's pass-through. */
  addr0x: string;
}

export function RevealableAddressBlock({ addr0x }: RevealableAddressBlockProps) {
  const [state, setState] = useState<RevealState>("closed");
  const [copied, setCopied] = useState(false);

  const handleShowWarning = (e: MouseEvent) => {
    e.stopPropagation();
    setState("warning");
  };
  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation();
    setState("closed");
  };
  const handleReveal = (e: MouseEvent) => {
    e.stopPropagation();
    setState("revealed");
  };
  const handleHide = (e: MouseEvent) => {
    e.stopPropagation();
    setState("closed");
  };
  const handleClose = () => setState("closed");

  const handleCopyBech32m = (e: MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(bech32mDisplay(addr0x)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <AddressLine addr0x={addr0x} format="bech32m" truncate={false} inlineCopy={false} />

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={handleCopyBech32m}
          aria-label="Copy mono1 address"
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
        <button
          onClick={handleShowWarning}
          style={{
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
      </div>

      <Modal
        open={state === "warning"}
        onClose={handleClose}
        title={
          <>
            <span aria-hidden="true">⚠</span>
            Show 0x hex format
          </>
        }
        titleAccent="rgba(242,180,65,1)"
      >
        <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--fg-100)" }}>
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
      </Modal>

      <Modal
        open={state === "revealed"}
        onClose={handleClose}
        title="0x address — Mono wire format"
      >
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <AddressLine addr0x={addr0x} format="hex" truncate={false} />
        </div>
        <div
          style={{
            fontSize: 10.5,
            lineHeight: 1.5,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
          }}
        >
          Identical shape to Ethereum addresses but NOT compatible.
          Sending from MetaMask = permanent loss (§22.7).
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={handleHide}
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
            Hide
          </button>
        </div>
      </Modal>
    </div>
  );
}
