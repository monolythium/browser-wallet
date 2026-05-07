import { QRCodeSVG } from "qrcode.react";
import { Icon } from "../Icon";
import type { Account } from "../demo-data";
import { bech32mDisplay } from "../../shared/bech32m";
import { RevealableAddressBlock } from "../components/RevealableAddressBlock";

interface ReceiveProps {
  account: Account;
  onBack: () => void;
}

export function Receive({ account, onBack }: ReceiveProps) {
  // Whitepaper §22.7 mandates bech32m display. The QR encodes the bech32m
  // form (canonical Monolythium). The two AddressLines below show both
  // mono1 and 0x with per-line copy icons — internal storage stays 0x.
  const qrPayload = bech32mDisplay(account.addr);

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
              value={qrPayload}
              size={224}
              level="M"
              marginSize={2}
            />
          </div>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.3)",
              border: "1px solid var(--fg-700)",
            }}
          >
            <RevealableAddressBlock addr0x={account.addr} />
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
