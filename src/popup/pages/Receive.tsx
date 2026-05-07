import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Icon } from "../Icon";
import type { Account } from "../demo-data";
import { bech32mDisplay } from "../../shared/bech32m";

interface ReceiveProps {
  account: Account;
  onBack: () => void;
}

export function Receive({ account, onBack }: ReceiveProps) {
  const [copied, setCopied] = useState(false);
  // Whitepaper §22.7 mandates bech32m for display. The QR is display, the
  // copy-button payload is display, the inline string is display — all use
  // the same bech32m form. Wire-format storage in `account.addr` stays 0x.
  const display = bech32mDisplay(account.addr);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(display);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail in iframes / focus-loss races. Stay quiet.
    }
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
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            Your address
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "12px",
              background: "white",
              borderRadius: 12,
              marginBottom: 12,
            }}
          >
            <QRCodeSVG
              value={display}
              size={224}
              level="M"
              marginSize={2}
            />
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--fg-100)",
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.3)",
              border: "1px solid var(--fg-700)",
              wordBreak: "break-all",
              userSelect: "all",
            }}
          >
            {display}
          </div>
          <button
            className="ext-act prim"
            onClick={() => void onCopy()}
            style={{
              width: "100%",
              padding: "10px",
              flexDirection: "row",
              gap: 8,
              marginTop: 12,
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
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
