// Compact pill for AddressLabelRecord.category. Mounted inline next to
// displayName in TxSend/Receive/TokenTransfer row bodies. NOT used in
// delegation bodies — cluster.mono is already an implicit category;
// a redundant badge would be visual noise.
//
// Color tokens live in tokens.css under --cat-*. The component reads
// them via var() so future theme variants (and the §22.8 hierarchical-
// name palette expansion) don't require editing this component.

export interface CategoryBadgeProps {
  category: string;
}

// Six known categories from the indexer's pragmatic taxonomy. The lookup
// table is intentionally `Record<string, ...>` so unknown categories
// (e.g. when the chain ships §22.8 names) fall through to `null` and
// render nothing rather than a default-styled badge.
const KNOWN_CATEGORIES = new Set([
  "foundation",
  "exchange",
  "bridge",
  "treasury",
  "contract",
  "operator",
]);

export function CategoryBadge({ category }: CategoryBadgeProps) {
  if (!KNOWN_CATEGORIES.has(category)) return null;
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
