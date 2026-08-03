// DevBadge — the wallet-wide marker for developer-mode surfaces.
//
// Renders `DEV` beside the title of a surface that exists ONLY because the
// user opted into developer mode, so an opted-in user can tell at a glance
// which parts of the wallet are developer surfaces and which are ordinary
// ones.
//
// Placement contract
// ==================
// ALWAYS render this inside the SAME conditional that gates the surface. The
// badge ALSO reads the flag itself, as a backstop rather than a substitute: a
// badge that reaches an ungated surface renders nothing instead of advertising
// "DEV" to a user who never opted in.
//
// The two reads can disagree for a frame, and the disagreement is one-way. The
// hook seeds `false` and resolves async, so the only reachable mismatch is
// surface-shown / badge-not-yet — a missing marker, which is the safe
// direction. The reverse (marker on an ungated surface) cannot happen from the
// double read: if the caller's gate is false the surface does not render, so
// this component never mounts to read anything. An earlier note here worried
// about that reverse case; it points the wrong way.
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

import { useFeature } from "../hooks/useFeature.js";

/** Marker for a developer-mode-only surface. Takes no props on purpose —
 *  uniform text, uniform placement, one place to restyle. Renders null unless
 *  developer mode is on, so the marker can never outlive the opt-in. */
export function DevBadge() {
  const devMode = useFeature("DEVELOPER_MODE");
  if (!devMode) return null;
  return (
    <span
      className="ext-badge-dev"
      title="Developer-mode surface — shown because you turned on developer mode."
    >
      DEV
    </span>
  );
}
