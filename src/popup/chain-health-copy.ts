// One source per chain state.
//
// Three surfaces describe the same condition and none of them may drift from
// the others:
//   - the status chip renders the LABEL, from `chainHealthPresentation`
//     (components.tsx) -- deliberately NOT duplicated here;
//   - the degraded-network banner renders `short`;
//   - the Help page's Connection status section renders `long`.
//
// `long` is the reviewed Help copy, moved here character-for-character from
// pages/Help.tsx. It was traced to code sentence by sentence before it shipped
// (see _dev-notes 2026-08-01_help-page-plan.md) and is frozen: a reword here is
// an untraced claim in front of a user.
//
// `short` is the banner's one-liner -- a glance, not a paragraph, with the long
// answer one tap away. Two rules it must keep:
//   1. It must never CONTRADICT its own `long`. A short form that disagrees
//      with the answer it links to is worse than either alone.
//   2. It must claim no more than the wallet can observe. The wallet sees a
//      reported height and a genesis verdict; it does not see WHY a chain
//      stopped, and it cannot estimate someone else's recovery time.
//
// `mechanics` is the developer-mode detail. Every value is rendered from the
// constant the logic actually reads -- never typed -- which is the whole point
// of showing it.

import {
  HEALTH_TICK_MS,
  STALL_THRESHOLD_MS,
  type ChainHealthKind,
} from "./components";

/** Render a millisecond constant as seconds. Every duration below goes through
 *  this — none is typed — so a change to the constant moves this text with it. */
const secs = (ms: number): string => `${Math.round(ms / 1000)} seconds`;

export interface ChainStateCopy {
  /** Banner one-liner. Null for the states the banner deliberately suppresses
   *  (`live`, plus the two transient states -- see BANNER_STATES below). */
  short: string | null;
  /** The Help answer. Frozen reviewed copy; see the header note. */
  long: string;
}

export const CHAIN_STATE_COPY: Record<ChainHealthKind, ChainStateCopy> = {
  loading: {
    short: null,
    long: "The wallet is contacting an operator. This clears on its own within a few seconds.",
  },
  reconnecting: {
    short: null,
    long: "The number is the last block this wallet saw in an earlier session — not a live reading. It's shown so you have a reference point while the wallet re-checks; it isn't confirmation that you're connected.",
  },
  live: {
    short: null,
    long: "An operator answered and the block height moved since the last check. That's all it means — it isn't a guarantee that the network is fully healthy.",
  },
  stalled: {
    // Deliberately says only what the poll observes: the reported height is
    // unchanged. The wallet cannot tell whether the chain, the operator, or a
    // load balancer serving a stuck backend is responsible, so it does not say.
    short: "Block height hasn't moved — your balance may be out of date.",
    long: "The network is answering, but the block height hasn't moved for a while. Your balance and activity are hidden because the wallet can't confirm they're current. This clears by itself as soon as the height moves again — it's usually the network, not your wallet.",
  },
  untrusted: {
    short: "This operator is serving a different network.",
    long: "The operator answered for a different network than this wallet expects. Your balance is hidden rather than shown from stale data. It clears automatically when the operator is back on the right network.",
  },
  regenesis: {
    // Deliberately hard. The genesis mismatch is sticky (networks.ts: a
    // definitive mismatch is never re-probed) and persists across a restart,
    // so every transaction fails until the wallet's pin is updated. Softening
    // this would be a comforting sentence that costs the user money.
    short: "The test network was restarted. This wallet needs an update.",
    long: "The operator is on the right network but reports a different starting point, which usually means the test network was restarted. This one generally needs a wallet update to resolve — there's no setting you can change.",
  },
  quarantined: {
    // "recovers on its own" and NOT "shortly": the 60s figure in the mechanics
    // is OUR re-probe interval, not an estimate of someone else's recovery.
    short: "The operator took itself out of service. It recovers on its own.",
    long: "The operator has taken itself out of service after an internal consistency check failed. It's on your network but won't answer for now, and recovers on its own.",
  },
  offline: {
    short: "Can't reach the network. Check your connection.",
    long: "The wallet can't reach any operator. Check your own internet connection first.",
  },
};

/** Render order for the Connection status section — the order a user meets the
 *  states in, from healthy-transient to hard failure. Also the order the Help
 *  page's ruled sequence uses, so the divider logic keys off the index. */
export const CHAIN_STATE_ORDER: ReadonlyArray<ChainHealthKind> = [
  "loading",
  "reconnecting",
  "live",
  "stalled",
  "untrusted",
  "regenesis",
  "quarantined",
  "offline",
];

/**
 * The states the banner renders for.
 *
 * `live` is healthy. `loading` and `reconnecting` are excluded because both are
 * replaced by the first poll result and NEITHER pauses anything —
 * `chainKindNotLive` returns false for them by design, so a healthy popup open
 * doesn't flash "—". A banner on either would fire on every single open and
 * warn about a condition the wallet itself does not treat as degraded, which is
 * the fastest way to teach a user to ignore the strip.
 *
 * Derived from the copy table rather than restated: a state with no `short`
 * line is a state the banner has nothing to say about.
 */
export const BANNER_STATES: ReadonlyArray<ChainHealthKind> =
  CHAIN_STATE_ORDER.filter((kind) => CHAIN_STATE_COPY[kind].short !== null);

/** Whether the banner renders for this health kind. */
export function bannerShowsFor(
  kind: ChainHealthKind | null | undefined,
): boolean {
  return kind != null && CHAIN_STATE_COPY[kind].short !== null;
}

/**
 * Developer-mode mechanics for a state: how the wallet decides it, and what
 * clears it. Written for someone debugging, not for a user.
 *
 * Every duration is rendered from the constant the logic reads — see `secs`.
 *
 * TWO NUMBERS ARE DELIBERATELY ABSENT:
 *
 *  - The genesis re-probe TTL that governs `quarantined` / `offline` is
 *    `GENESIS_OBSERVED_NULL_TTL_MS` in background/networks.ts. It is NOT
 *    exported, and that module carries chrome APIs, so importing it here would
 *    drag the background into the popup bundle. Since the number cannot be
 *    derived it is not stated — a typed copy of a constant is the exact defect
 *    these blocks exist to demonstrate against.
 *  - `OPERATOR_TICK_MS` (the operator-NAME poll) is excluded everywhere. A
 *    plausible-looking wrong number beside a health mechanic is worse than an
 *    absent one.
 */
export function chainStateMechanics(kind: ChainHealthKind): string {
  switch (kind) {
    case "loading":
      return `Replaced by the first poll result. Polls every ${secs(HEALTH_TICK_MS)}.`;
    case "reconnecting":
      return "Seeded from the block persisted in a previous session; replaced by the first confirmed head this session.";
    case "live":
      return "Set whenever the polled height differs from the previous one — any change counts, including a decrease.";
    case "stalled":
      return `Polls every ${secs(HEALTH_TICK_MS)}; verdicts stalled once the height has been unchanged for ${secs(STALL_THRESHOLD_MS)}. Clears on any different height.`;
    case "untrusted":
      return "The operator reported a different chain id. Cleared on the next check that matches.";
    case "regenesis":
      return "Right chain id, different genesis hash. The mismatch is sticky — never re-probed — and is persisted, so it survives a restart. Cleared only by a forced re-probe.";
    case "quarantined":
      return "Every operator answered with a checkpoint state-root mismatch. Re-probed once the genesis cache entry expires.";
    case "offline":
      return "Unreachable, or the request failed. Re-probed once the genesis cache entry expires.";
  }
}
