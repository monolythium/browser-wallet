// Degraded-network banner.
//
// Renders at the top of the main strip whenever the chain-health verdict is
// anything the wallet has something to say about, with a one-line summary and
// an action that opens the Help page on that state's own entry.
//
// It OBSERVES. It reads the health kind App already lifted out of the status
// chip and renders text; it does not poll, gate, pause or participate in the
// state machine in any way.
//
// Three design points that are not obvious from the code:
//
//   1. THREE TINTS, NOT EIGHT. `chainHealthPresentation` gives four states the
//      same `--err` deliberately — the comments there call it the hard-trust
//      token. A tint per state would invent a distinction the palette refuses
//      to make, so states are grouped by the colour they already share.
//
//   2. NO BANNER FOR THE TRANSIENT STATES. `loading` and `reconnecting` are
//      each replaced by the first poll result, and `chainKindNotLive` returns
//      false for both by design. A banner there would fire on every popup open
//      and warn about something the wallet itself does not treat as degraded —
//      the fastest way to teach a user to ignore the strip. Enforced by the
//      copy source: a state with no `short` line gets no banner.
//
//   3. `regenesis` CANNOT BE DISMISSED. Every other state self-heals, so
//      silencing one for a session costs nothing. A genesis mismatch is sticky
//      (never re-probed) and persisted, so it survives a restart, and every
//      transaction fails until the wallet's pin is updated. A warning the user
//      can permanently silence for a condition that cannot clear on its own is
//      the one case where dismissal is wrong.
//
// Dismissal is per-session `useState` and NEVER persisted, matching
// IndexerStaleBanner: a degraded chain is a transient runtime condition, not a
// user preference. The component unmounts when the state clears, so a state
// that clears and returns shows a fresh, undismissed banner.

import { useState } from "react";

import { CHAIN_STATE_COPY } from "../chain-health-copy";
import type { ChainHealthKind } from "../components";

/** States that share `--err` — the "hard-trust" tint. Everything else the
 *  banner renders for takes the warn tint. */
const DANGER_STATES: ReadonlySet<ChainHealthKind> = new Set<ChainHealthKind>([
  "untrusted",
  "regenesis",
  "quarantined",
  "offline",
]);

/** The one state whose warning must stay on screen — see note 3 above. */
const UNDISMISSABLE: ChainHealthKind = "regenesis";

export interface ChainHealthBannerProps {
  /** The health kind App lifted from the status chip. Null before the first
   *  verdict lands — nothing renders until the wallet actually knows. */
  kind: ChainHealthKind | null;
  /** Opens Help on this state's entry. */
  onExplain: (kind: ChainHealthKind) => void;
}

export function ChainHealthBanner({ kind, onExplain }: ChainHealthBannerProps) {
  const [dismissed, setDismissed] = useState<ChainHealthKind | null>(null);

  if (kind === null) return null;
  const short = CHAIN_STATE_COPY[kind].short;
  // A state with nothing to say (live, and the two transient states) gets no
  // banner. Derived from the copy source rather than restated here.
  if (short === null) return null;
  if (dismissed === kind) return null;

  const dismissable = kind !== UNDISMISSABLE;

  return (
    <div
      className={`ext-indexer-stale ext-chain-banner ${
        DANGER_STATES.has(kind) ? "ext-chain-danger" : "ext-chain-warn"
      }`}
      role="status"
      aria-live="polite"
    >
      <span className="text">
        {short}{" "}
        <button
          type="button"
          className="ext-chain-explain"
          onClick={() => onExplain(kind)}
        >
          What does this mean?
        </button>
      </span>
      {dismissable && (
        <button
          type="button"
          className="close"
          onClick={() => setDismissed(kind)}
          aria-label="Dismiss the network warning for this session"
        >
          ×
        </button>
      )}
    </div>
  );
}
