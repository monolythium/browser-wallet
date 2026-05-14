// Phase 5 Commit 6 — NftTab. Compressed from
// `browser-wallet-old/src/popup/components/NftTab.tsx` (721 LOC) to
// the v1 surface area:
//   - Pinned NFTs only (no eth_getLogs discovery — Sprintnet's
//     indexer is cluster-wide disabled today).
//   - Single flat grid view. Stripped: grouped/accordion view,
//     viewMode toggle, persisted view-mode storage key, scroll-
//     into-view choreography.
//   - Stripped: multi-chain switcher, auto-discovery refresh button,
//     bulk import, search/filter, settings toggle, ENS resolution UI.
//
// Two-phase load:
//   Phase 1 — read pinned list from chrome.storage and metadata cache
//     synchronously; render whatever cards have hits immediately.
//   Phase 2 — for cards without metadata, fire `fetchOrCacheNftMetadata`
//     in parallel against an EthCaller wired to bgEthCall. Each
//     resolved metadata flips the corresponding card from skeleton-
//     pulse to image. The metadata cache (24 h TTL) absorbs repeat
//     visits — Phase 2 is a no-op when every pin has a fresh hit.
//
// Sprintnet footnote (always visible) is the locked v1 educational
// copy from plan B.6 Q4 + Q5: text-only, dimmer in non-empty state,
// reframes "indexer disabled" as "discovery off — pinning + transfers
// work normally" so users don't read the missing auto-discovery as
// the feature being broken. Commit 8 polished the typography to the
// locked spec (text-only, fg-500, 11 px, lh 1.4, max-width 320 px,
// centered).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../Icon";
import { NftCard, type NftCardEntry } from "./NftCard";
import { NftDetail, type NftDetailEntry, type NftStandard } from "./NftDetail";
import { NftAddModal } from "./NftAddModal";
import type { SendNftTarget } from "../pages/SendNft";
import {
  fetchOrCacheNftMetadata,
  getCachedNftMetadata,
  loadPinnedNfts,
  supportsErc1155,
  unpinNft,
  type EthCaller,
  type NftMetadata,
  type PinnedNft,
} from "../../lib/nft-client";
import { bgEthCall } from "../bg";

interface NftTabProps {
  /** Active vault EVM address (`0x` 40-hex). Null while the popup
   *  is still resolving the active vault; the empty state covers
   *  that brief window. */
  ownerAddress: string | null;
  /** Current chain id (decimal). Sprintnet today; future chains
   *  pass straight through to the pinned-list filter. */
  chainId: number;
  /** Active chain id in `0x`-hex form, threaded into bgEthCall. */
  chainIdHex: string;
  /** Phase 5 Commit 7 — fired when NftDetail's Send CTA is clicked.
   *  Optional so test harnesses without the SendNft route still
   *  compile; when omitted the Send button is a no-op. */
  onOpenSendNft?: (target: SendNftTarget) => void;
}

/** In-memory NFT row joined from a PinnedNft + the metadata cache /
 *  Phase-2 fetch. `metadata === undefined` means Phase 2 is still in
 *  flight; cards render their skeleton-pulse for that case. */
interface NftRow {
  pinned: PinnedNft;
  standard: NftStandard;
  metadata: NftMetadata | undefined;
}

const SPRINTNET_FOOTNOTE =
  "NFT discovery uses on-chain event indexing, which is currently disabled on Sprintnet. You can still pin any NFT you own by contract address — sending and receiving work normally.";

export function NftTab({ ownerAddress, chainId, chainIdHex, onOpenSendNft }: NftTabProps) {
  const caller: EthCaller = useMemo(
    () => ({
      ethCall: async (req) => {
        const r = await bgEthCall(req.to, req.data, chainIdHex);
        if (!r.ok) throw new Error(r.reason ?? "eth_call failed");
        return r.result;
      },
    }),
    [chainIdHex],
  );

  const [rows, setRows] = useState<NftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<NftRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  // Phase 5 Commit 7 — Send navigation bubbles to App.tsx via the
  // `onOpenSendNft` callback so SendNft renders as a top-level
  // popup screen (matching Send.tsx). Rendering it inside the NFT
  // tab card breaks SendNft's `.ext-top` / `.ext-body` layout, which
  // expects to live at the popup root.

  // A monotonic ref so out-of-order Phase-2 results from a previous
  // refresh don't clobber the current view.
  const loadGen = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);

    const allPinned = await loadPinnedNfts();
    const forChain = allPinned.filter((p) => p.chainId === chainId);

    // Phase 1 — synchronous cache lookup, sequential is fine because
    // chrome.storage is fast and the pinned list is small in v1.
    const initial: NftRow[] = [];
    for (const p of forChain) {
      const tokenIdBig = (() => {
        try {
          return BigInt(p.tokenId);
        } catch {
          return 0n;
        }
      })();
      const cached = await getCachedNftMetadata(p.address, tokenIdBig);
      initial.push({
        pinned: p,
        standard: "erc721", // Phase 2 corrects this if the contract is 1155.
        metadata: cached ?? undefined,
      });
    }

    if (loadGen.current !== gen) return;
    setRows(initial);
    setLoading(false);

    // Phase 2 — for every pin without a cache hit, detect standard
    // (ERC-1155 vs ERC-721) and fetch+cache fresh metadata. The cache
    // already absorbed the hit case; this loop is a no-op for visits
    // where every pin is fresh.
    const needsFetch = initial
      .map((row, idx) => ({ row, idx }))
      .filter((x) => x.row.metadata === undefined);

    await Promise.all(
      needsFetch.map(async ({ row, idx }) => {
        const tokenIdBig = (() => {
          try {
            return BigInt(row.pinned.tokenId);
          } catch {
            return 0n;
          }
        })();
        let standard: NftStandard = "erc721";
        try {
          if (await supportsErc1155(caller, row.pinned.address)) {
            standard = "erc1155";
          }
        } catch {
          /* keep default ERC-721 */
        }
        const meta = await fetchOrCacheNftMetadata(
          caller,
          row.pinned.address,
          tokenIdBig,
          { isErc1155: standard === "erc1155" },
        ).catch(() => null);

        if (loadGen.current !== gen) return;
        setRows((prev) => {
          const next = prev.slice();
          const existing = next[idx];
          if (!existing) return prev;
          next[idx] = {
            ...existing,
            standard,
            metadata: meta ?? undefined,
          };
          return next;
        });
      }),
    );
  }, [caller, chainId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Clear the highlight ring after 2 s.
  useEffect(() => {
    if (!highlightKey) return;
    const t = setTimeout(() => setHighlightKey(null), 2000);
    return () => clearTimeout(t);
  }, [highlightKey]);

  const handleUnpin = async (row: NftRow) => {
    await unpinNft(chainId, row.pinned.address, row.pinned.tokenId);
    await refresh();
  };

  const handleAdded = (contractAddress: string, tokenId: string) => {
    setAdding(false);
    setHighlightKey(`${contractAddress.toLowerCase()}:${tokenId}`);
    void refresh();
  };

  // ---- Sub-views ----

  if (selected) {
    const detail: NftDetailEntry = {
      contractAddress: selected.pinned.address,
      tokenId: selected.pinned.tokenId,
      collectionName: selected.metadata?.name ?? selected.pinned.address,
      standard: selected.standard,
      ...(selected.metadata !== undefined ? { metadata: selected.metadata } : {}),
    };
    return (
      <NftDetail
        nft={detail}
        onBack={() => setSelected(null)}
        onSend={() => {
          // Phase 5 Commit 7 — bubble to App.tsx, which stashes the
          // target NFT and routes to the SendNft screen so the page
          // renders at the popup root (not inside the NFT tab card).
          // No-op when the route isn't wired (test harnesses).
          if (!onOpenSendNft) return;
          onOpenSendNft({
            contractAddress: selected.pinned.address,
            tokenId: selected.pinned.tokenId,
            collectionName: detail.collectionName,
            standard: selected.standard,
            ...(selected.metadata !== undefined ? { metadata: selected.metadata } : {}),
          });
        }}
        onRemove={() => {
          void handleUnpin(selected).then(() => setSelected(null));
        }}
      />
    );
  }

  // ---- Loading / empty / grid ----

  if (loading) {
    return (
      <div style={{ padding: "24px 12px", textAlign: "center" }}>
        <div
          style={{
            fontSize: 12,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
          }}
        >
          Loading…
        </div>
        <Footnote />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        <div
          style={{
            padding: "20px 12px 12px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            textAlign: "center",
          }}
        >
          <EmptyGlyph />
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-100)" }}>
            No NFTs yet
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-400)",
              maxWidth: 280,
              lineHeight: 1.5,
            }}
          >
            Pin NFTs you own by entering the contract address and token
            ID.
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={{
              marginTop: 6,
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid rgba(124,127,255,0.6)",
              background: "rgba(124,127,255,0.18)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon name="plus" size={12} />
            Add by contract address
          </button>
        </div>
        <Footnote />
        <NftAddModal
          open={adding}
          caller={caller}
          chainId={chainId}
          ownerAddress={ownerAddress}
          onClose={() => setAdding(false)}
          onAdded={handleAdded}
        />
      </>
    );
  }

  return (
    <>
      <div style={{ padding: "4px 0 8px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          {rows.map((row) => {
            const key = `${row.pinned.address.toLowerCase()}:${row.pinned.tokenId}`;
            const cardNft: NftCardEntry = {
              contractAddress: row.pinned.address,
              tokenId: row.pinned.tokenId,
              collectionName:
                row.metadata?.name ?? `${row.pinned.address.slice(0, 8)}…`,
              ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
              isCustom: true,
            };
            return (
              <NftCard
                key={key}
                nft={cardNft}
                onClick={() => setSelected(row)}
                onRemove={() => void handleUnpin(row)}
                {...(highlightKey === key ? { highlight: true } : {})}
              />
            );
          })}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 10,
          }}
        >
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              background: "transparent",
              border: "1px solid var(--fg-700)",
              color: "var(--fg-200)",
              fontFamily: "var(--f-sans)",
              fontSize: 11,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Icon name="plus" size={11} />
            Add NFT
          </button>
        </div>
      </div>
      <Footnote compact />
      <NftAddModal
        open={adding}
        caller={caller}
        chainId={chainId}
        ownerAddress={ownerAddress}
        onClose={() => setAdding(false)}
        onAdded={handleAdded}
      />
    </>
  );
}

/** Always-visible educational footnote per plan B.6 Q4 + Q5.
 *  `compact` renders the slightly smaller / dimmer variant below the
 *  populated grid (the non-empty state); the empty state uses the
 *  locked-spec dimensions verbatim. */
function Footnote({ compact = false }: { compact?: boolean }) {
  return (
    <div
      style={{
        marginTop: 12,
        marginLeft: "auto",
        marginRight: "auto",
        maxWidth: 320,
        fontSize: compact ? 10 : 11,
        lineHeight: 1.4,
        color: "var(--fg-500)",
        textAlign: "center",
        opacity: compact ? 0.85 : 1,
      }}
    >
      {SPRINTNET_FOOTNOTE}
    </div>
  );
}

function EmptyGlyph() {
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ color: "var(--fg-500)" }}
    >
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
