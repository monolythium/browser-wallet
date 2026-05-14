// Phase 5 Commit 6 — NftCard. Ported from
// `browser-wallet-old/src/popup/components/NftCard.tsx` (82 LOC).
//
// Visual contract preserved: aspect-square thumbnail, lazy `<img>`
// with skeleton-pulse during loading, footer line with collection
// name + tokenId/title with ellipsis, hover-revealed `×` button
// when `onRemove` is provided. Click anywhere on the card body opens
// detail.
//
// Adapted from Tailwind classes to inline styles + the wallet's CSS
// tokens. lucide-react icons swapped for inline SVGs that match the
// rest of the popup (no new icon dependency).

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { sanitizeImageUri, type NftMetadata } from "../../lib/nft-client";

export interface NftCardEntry {
  contractAddress: string;
  /** Decimal string for display + key purposes. -1 marks a
   *  "collection summary" placeholder (rare on Sprintnet today). */
  tokenId: string;
  collectionName: string;
  metadata?: NftMetadata;
  isCustom?: boolean;
}

interface NftCardProps {
  nft: NftCardEntry;
  onClick: () => void;
  /** When provided, renders the hover-only `×` button. Used for
   *  pinned NFTs (every NFT in v1 is pinned). */
  onRemove?: () => void;
  /** Pulses a primary-colored ring for ~2 s after a manual add so
   *  the user can spot the new card in the grid. */
  highlight?: boolean;
}

export function NftCard({ nft, onClick, onRemove, highlight }: NftCardProps) {
  const [imgError, setImgError] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (!highlight) return;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), 2000);
    return () => clearTimeout(t);
  }, [highlight]);

  const imageUrl = sanitizeImageUri(nft.metadata?.image);
  const isSummary = nft.tokenId === "-1";
  const displayName = nft.metadata?.name || `#${nft.tokenId}`;
  const metadataLoading = nft.metadata === undefined && !isSummary;

  const wrapperStyle: CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    borderRadius: 12,
    border: pulsing
      ? "1px solid rgba(124,127,255,0.7)"
      : "1px solid var(--glass-stroke)",
    background: "var(--glass-fill)",
    overflow: "hidden",
    cursor: "pointer",
    transition: "border-color 160ms var(--e-out)",
    boxShadow: pulsing
      ? "0 0 0 3px rgba(124,127,255,0.25)"
      : undefined,
  };

  return (
    <div
      style={wrapperStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Unpin NFT"
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            zIndex: 2,
            width: 18,
            height: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 999,
            background: "rgba(0,0,0,0.6)",
            color: "var(--fg-100)",
            border: "none",
            cursor: "pointer",
            opacity: hovered ? 1 : 0,
            transition: "opacity 120ms var(--e-out)",
          }}
        >
          <CloseGlyph />
        </button>
      )}

      <button
        type="button"
        onClick={onClick}
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          padding: 0,
          background: "transparent",
          border: "none",
          color: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            width: "100%",
            aspectRatio: "1 / 1",
            background: "rgba(255,255,255,0.04)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {metadataLoading ? (
            <div
              style={{
                width: "100%",
                height: "100%",
                background:
                  "linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.04) 100%)",
                animation: "pulse 1.4s ease-in-out infinite",
              }}
            />
          ) : imageUrl && !imgError ? (
            <img
              src={imageUrl}
              alt={displayName}
              loading="lazy"
              onError={() => setImgError(true)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <div
              style={{
                color: "var(--fg-500)",
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
              }}
            >
              <ImageGlyph />
              {isSummary && (
                <span style={{ fontSize: 9, color: "var(--fg-500)" }}>
                  Collection
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: "6px 8px 8px" }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--fg-400)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.3,
            }}
            title={nft.collectionName}
          >
            {nft.collectionName}
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--fg-100)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.3,
            }}
            title={displayName}
          >
            {displayName}
          </div>
        </div>
      </button>
    </div>
  );
}

// ---- Inline glyphs (no lucide-react in the new wallet) ----

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 3.5l9 9M12.5 3.5l-9 9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
