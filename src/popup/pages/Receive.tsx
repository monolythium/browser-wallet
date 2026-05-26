import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Icon } from "../Icon";
import type { Account } from "../demo-data";
import { bech32mDisplay } from "../../shared/bech32m";
import { CheckIcon, ClipboardIcon } from "../components/AddressLine";

interface ReceiveProps {
  account: Account;
  onBack: () => void;
}

export function Receive({ account, onBack }: ReceiveProps) {
  // Whitepaper §22.7 mandates bech32m display. The QR encodes the bech32m
  // form (canonical Monolythium); the address row below renders the
  // same string at 14 px mono so it (not the QR) is the screen's
  // primary visual element — see Round 5 TASK 6.
  const qrPayload = bech32mDisplay(account.addr);
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: ReactMouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(qrPayload).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Receive
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card" style={{ padding: 14 }}>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: 10,
              textAlign: "center",
            }}
          >
            Your address
          </div>
          {/* Round 5 TASK 6 — QR dropped from 224 to 176 px so the
              address row below it has visual prominence. Address card
              padding and font size grow accordingly so the actual
              text (not the pixel grid) is the takeaway. */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "10px",
              background: "white",
              borderRadius: 12,
              marginBottom: 12,
              maxWidth: 200,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            <QRCodeSVG
              value={qrPayload}
              size={176}
              level="M"
              marginSize={2}
            />
          </div>
          {/* Round 6 TASK 4 — address now strictly single-line. Round 5
              used wordBreak:break-all which wrapped a 43-char bech32m
              onto two lines in popup mode. Now nowrap + tighter
              padding + 24 px copy button gives the address ~274 px of
              clear width, which fits a 12.5 px JBM string at -0.04 em
              letter-spacing (~273 px measured). Inline copy stays
              right next to the address with a 6 px gap — not pushed
              to the far right via margin-auto. */}
          <div
            onClick={handleCopy}
            title={copied ? "Copied" : "Click to copy"}
            style={{
              padding: "10px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.3)",
              border: "1px solid var(--fg-700)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "copy",
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: "var(--f-mono)",
                fontSize: 12.5,
                fontWeight: 500,
                color: copied ? "var(--ok, #5fc97a)" : "var(--fg-100)",
                letterSpacing: "-0.04em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "clip",
                userSelect: "all",
              }}
            >
              {qrPayload}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy address"
              title={copied ? "Copied" : "Copy address"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                padding: 0,
                background: "transparent",
                border: "none",
                color: copied ? "var(--ok, #5fc97a)" : "var(--fg-300)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {copied ? <CheckIcon /> : <ClipboardIcon />}
            </button>
          </div>
        </div>

        <div
          className="ext-card"
          style={{
            padding: "10px 12px",
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Network
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--fg-100)" }}>
            Send LYTH on Sprintnet only. Chain id 69420 (0x10F2C). Sending
            LYTH from a different chain may result in lost funds.
          </div>
        </div>
      </div>
    </>
  );
}
