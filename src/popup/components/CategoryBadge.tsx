// Compact pill for AddressLabelRecord.category. Mounted inline next to
// displayName in TxSend/Receive/TokenTransfer row bodies. NOT used in
// delegation bodies — cluster.mono is already an implicit category;
// a redundant badge would be visual noise.
//
// Inline styles only — no new CSS classes per the commit 11 constraint.
// Commit 12 polishes the color palette and may extract these to .ext-*
// classes for theme consistency.

export interface CategoryBadgeProps {
  category: string;
}

const CATEGORY_COLORS: Record<string, { bg: string; fg: string }> = {
  foundation: { bg: "rgba(225, 175, 90, 0.15)", fg: "#e1af5a" },
  exchange: { bg: "rgba(80, 150, 230, 0.15)", fg: "#5096e6" },
  bridge: { bg: "rgba(70, 200, 200, 0.15)", fg: "#46c8c8" },
  treasury: { bg: "rgba(80, 200, 110, 0.15)", fg: "#50c86e" },
  contract: { bg: "rgba(170, 170, 180, 0.15)", fg: "#aaaab4" },
  operator: { bg: "rgba(180, 120, 220, 0.15)", fg: "#b478dc" },
};

export function CategoryBadge({ category }: CategoryBadgeProps) {
  // Unknown category → render no badge. Forward-compat for the §22.8
  // hierarchical taxonomy: when the indexer ships .mono / .agent.<h>.mono
  // / .cluster.mono categories, this component will need a palette
  // expansion in commit 12 or later.
  const palette = CATEGORY_COLORS[category];
  if (!palette) return null;
  return (
    <span
      style={{
        display: "inline-block",
        marginLeft: 6,
        padding: "1px 6px",
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
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
