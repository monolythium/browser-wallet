// Compact pill rendered next to a counterparty's displayName in
// TxSend/Receive/TokenTransfer row bodies, and next to recipient
// previews in Send. NOT used in delegation bodies — cluster.mono is
// already an implicit category; a redundant badge would be visual
// noise.
//
// Color tokens live in tokens.css under --cat-*. The component reads
// them via var() so future theme variants and §22.8 TLD palette overrides
// don't require editing this component.
//
// Two taxonomies coexist:
//   - Indexer pragmatic taxonomy (foundation/exchange/bridge/treasury
//     /contract/operator). Surfaced today by `lyth_getAddressLabel`.
//   - §22.8 TLD categories (human/agent/cluster/contract/system).
//     Surfaced when the indexer emits `.mono` hierarchical names in
//     `displayName`. The popup parses these via parseMonoName and passes
//     the TLD as `category`; this component renders both flavors
//     uniformly. "contract" is shared between both taxonomies and uses
//     a single token — semantically the same concept either way.

import type { MonoTld } from "../../shared/name-resolution.js";

export interface CategoryBadgeProps {
  /** Either an indexer pragmatic category or a §22.8 TLD label. */
  category: string;
}

/** Indexer pragmatic taxonomy (today's lyth_getAddressLabel emit). */
const PRAGMATIC_CATEGORIES = new Set([
  "foundation",
  "exchange",
  "bridge",
  "treasury",
  "contract",
  "operator",
]);

/** §22.8 TLD categories (parseMonoName output). */
const TLD_CATEGORIES = new Set<MonoTld>([
  "human",
  "agent",
  "cluster",
  "contract",
  "system",
]);

function isRenderableCategory(c: string): boolean {
  return PRAGMATIC_CATEGORIES.has(c) || TLD_CATEGORIES.has(c as MonoTld);
}

export function CategoryBadge({ category }: CategoryBadgeProps) {
  if (!isRenderableCategory(category)) return null;
  return (
    <span
      style={{
        display: "inline-block",
        marginLeft: 6,
        padding: "1px 6px",
        borderRadius: 4,
        background: `var(--cat-${category}-bg)`,
        color: `var(--cat-${category}-fg)`,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        verticalAlign: "1px",
      }}
    >
      {category}
    </span>
  );
}
