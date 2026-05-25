// Phase 5 Commit 6 — NftDetail. Ported from
// `browser-wallet-old/src/popup/components/NftDetail.tsx` (171 LOC).
//
// Visual contract preserved: header with back arrow + collection name,
// large square image, name + tokenId, optional description, contract-
// info card (collection / contract addr with copy / standard), 2-col
// attribute grid, Send CTA in the footer. Tailwind classes swapped
// for inline styles + popup CSS tokens; lucide-react icons swapped
// for inline SVGs (close/back) + the existing AddressLine clipboard
// glyph for copy. ENS / explorer-link UI stripped per the prompt's
// strip list; the contract address with copy is the only on-chain
// reference shown.
//
// Send button is a no-op pending Commit 7 (SendNft page). The button
// itself + the layout slot are wired so Commit 7 only swaps the
// onSend handler.

import { useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../Icon";
import { ClipboardIcon, CheckIcon } from "./AddressLine";
import { sanitizeImageUri, type NftMetadata } from "../../lib/nft-client";

export type NftStandard = "erc721" | "erc1155";

export interface NftDetailEntry {
  contractAddress: string;
  tokenId: string;
  collectionName: string;
  standard: NftStandard;
  metadata?: NftMetadata;
}

interface NftDetailProps {
  nft: NftDetailEntry;
  onBack: () => void;
  /** Open the SendNft sub-view in the parent. Wired in Commit 7. */
  onSend: () => void;
  /** Optional unpin handler — when provided, surfaces a secondary
   *  "Remove" button alongside Send. */
  onRemove?: () => void;
  /** Phase 9 — when `false`, hide the rich-metadata pieces
   *  (description blurb + attributes grid). Header, image,
   *  collection / contract / standard card, and Send/Remove CTAs
   *  stay visible. Default `true` so callers that haven't been
   *  retrofitted with the §28.5 Q29 MARKETPLACE flag still render
   *  the existing UI. */
  showRichMetadata?: boolean;
}

export function NftDetail({
  nft,
  onBack,
  onSend,
  onRemove,
  showRichMetadata = true,
}: NftDetailProps) {
  const [imgError, setImgError] = useState(false);
  const [copied, setCopied] = useState(false);

  const imageUrl = sanitizeImageUri(nft.metadata?.image);
  const displayName =
    nft.metadata?.name || `${nft.collectionName} #${nft.tokenId}`;

  const truncateAddr = (addr: string) =>
    addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;

  const copyContract = () => {
    void navigator.clipboard.writeText(nft.contractAddress).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  // Whitepaper §22.5 — display label uses the Mono-native MRC standard
  // family (MRC-721 / MRC-1155). The wallet still reads ERC-shaped
  // contracts via the EVM compat path until operators ship the native
  // lyth_mrc* RPC, so the internal `standard` field name stays "erc*".
  const standardLabel = nft.standard === "erc1155" ? "MRC-1155" : "MRC-721";

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
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "0 8px",
          }}
          title={nft.collectionName}
        >
          {nft.collectionName}
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div
        style={{
          padding: "12px 16px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          overflowY: "auto",
          flex: 1,
        }}
      >
        <div
          style={{
            width: "100%",
            aspectRatio: "1 / 1",
            borderRadius: 12,
            overflow: "hidden",
            background: "rgba(255,255,255,0.04)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {imageUrl && !imgError ? (
            <img
              src={imageUrl}
              alt={displayName}
              onError={() => setImgError(true)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <div style={{ color: "var(--fg-500)" }}>
              <ImageGlyph />
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-100)" }}>
            {displayName}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-400)",
              fontFamily: "var(--f-mono)",
              marginTop: 2,
            }}
          >
            Token ID: {nft.tokenId}
          </div>
        </div>

        {showRichMetadata && nft.metadata?.description && (
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-300)",
              lineHeight: 1.55,
            }}
          >
            {nft.metadata.description.slice(0, 500)}
          </div>
        )}

        <div
          style={{
            border: "1px solid var(--glass-stroke)",
            borderRadius: 12,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <DetailRow
            label="Collection"
            value={
              <span
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-100)",
                  fontWeight: 500,
                }}
              >
                {nft.collectionName}
              </span>
            }
          />
          <DetailRow
            label="Contract"
            value={
              <button
                type="button"
                onClick={copyContract}
                aria-label="Copy contract address"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  color: copied ? "var(--ok, #5fc97a)" : "var(--fg-300)",
                  fontFamily: "var(--f-mono)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
                title={nft.contractAddress}
              >
                <span>{truncateAddr(nft.contractAddress)}</span>
                {copied ? <CheckIcon /> : <ClipboardIcon />}
              </button>
            }
          />
          <DetailRow
            label="Standard"
            value={
              <span style={{ fontSize: 11.5, color: "var(--fg-100)" }}>
                {standardLabel}
              </span>
            }
          />
        </div>

        {showRichMetadata && nft.metadata?.attributes && nft.metadata.attributes.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: "var(--fg-400)",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Attributes
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 6,
              }}
            >
              {nft.metadata.attributes.map((attr, i) => (
                <div
                  key={i}
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid var(--glass-stroke)",
                    borderRadius: 8,
                    padding: "6px 8px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "var(--fg-400)",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                    }}
                  >
                    {attr.trait_type}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "var(--fg-100)",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={String(attr.value)}
                  >
                    {String(attr.value)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div
        className="req-foot"
        style={{
          marginTop: "auto",
          gridTemplateColumns: onRemove ? "1fr 1fr" : "1fr",
        }}
      >
        {onRemove && <button onClick={onRemove}>Remove</button>}
        <button className="prim" onClick={onSend}>
          Send
        </button>
      </div>
    </>
  );
}

interface DetailRowProps {
  label: string;
  value: ReactNode;
}

function DetailRow({ label, value }: DetailRowProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--fg-400)",
          fontFamily: "var(--f-mono)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {value}
    </div>
  );
}

function ImageGlyph() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M21 15l-5-5L5 21"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
