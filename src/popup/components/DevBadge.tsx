// DevBadge — the wallet-wide marker for developer-mode surfaces.
//
// Renders `DEV` beside the title of a surface that exists ONLY because the
// user opted into developer mode, so an opted-in user can tell at a glance
// which parts of the wallet are developer surfaces and which are ordinary
// ones.
//
// Placement contract
// ==================
// ALWAYS render this inside the SAME conditional that gates the surface —
// never behind a second `useFeature("DEVELOPER_MODE")` read. Two independent
// reads could disagree for a frame (the hook seeds `false` and resolves
// async), which would flash a marker on an ungated surface. Rendering inside
// the existing gate makes that structurally impossible.
//
// Why a component and not a bare className: the house badge pattern
// (`.ext-badge-att` / `.ext-badge-bridged`) is a raw CSS class inlined at each
// call site. That was fine for two one-off badges; this marker lands on ~19
// surfaces, so it gets a single component and a single style rule and stays
// restyleable from one place.
//
// Styling lives in ext.css as `.ext-badge-dev`, a sibling of the existing
// `.ext-badge-*` family — same geometry (mono 8px, uppercase, 1px 5px,
// radius 3), neutral palette so it never competes with the ok/warn/err status
// colors those badges use. The 6px left margin is baked into the rule rather
// than set per call site, so spacing is uniform everywhere.

/** Marker for a developer-mode-only surface. Takes no props on purpose —
 *  uniform text, uniform placement, one place to restyle. */
export function DevBadge() {
  return (
    <span
      className="ext-badge-dev"
      title="Developer-mode surface — shown because you turned on developer mode."
    >
      DEV
    </span>
  );
}
