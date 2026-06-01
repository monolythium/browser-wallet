// Monolythium wallet logo — the gradient squircle + the "M" mark.
//
// The mark is the official Monolythium "M" (isometric folded-ribbon),
// vectorized from the brand asset (Monolythium-Black-LR) into crisp SVG
// paths so it stays sharp at any size. The squircle fill is the active
// theme's accent gradient (var(--gold-hi) -> var(--gold)); the mark is the
// theme's base ink (var(--ink-000)) via currentColor. This is the exact
// token pairing the previous bare "M" glyph (and every primary button)
// used, so the logo recolors with the theme — well-tinted, good contrast —
// in every theme, automatically.

interface WalletLogoProps {
  /** Square footprint of the gradient squircle, in px. Default 56. */
  size?: number;
}

// The four sub-paths are the brand mark's four pieces (left outer leg;
// top chevron + right outer leg; left inner leg; right inner leg), traced
// from the 693px asset. viewBox 23 23 185 185 centres the mark with even
// padding inside the squircle.
const M_MARK =
  "M52 31 L79 46 L54 60 L54 199 L31 186 L31 43 Z " +
  "M178 31 L200 43 L200 186 L176 200 L176 61 L117 93 L64 65 L89 51 L116 66 Z " +
  "M79 103 L103 116 L103 186 L80 199 Z " +
  "M150 103 L151 199 L128 186 L128 116 Z";

export function WalletLogo({ size = 56 }: WalletLogoProps) {
  const glyph = Math.round(size * 0.7);
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--r-xl)",
        background: "linear-gradient(180deg, var(--gold-hi), var(--gold))",
        boxShadow:
          "0 8px 22px rgba(var(--gold-glow), 0.35), inset 0 1px 0 rgba(255,255,255,0.35)",
        // Drives the SVG's currentColor — same token the bare "M" used, so
        // the mark tracks the theme exactly as before.
        color: "var(--ink-000)",
      }}
      aria-hidden="true"
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="23 23 185 185"
        fill="currentColor"
        role="img"
        aria-label="Monolythium"
      >
        <path d={M_MARK} />
      </svg>
    </div>
  );
}
