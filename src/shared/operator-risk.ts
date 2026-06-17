// Operator risk classification.
//
// This module is the wallet's client-side risk-flag classifier: it derives
// flags from the data the per-operator probe already collects — genesis
// verification, capability surface, indexer lag, latency, error state. It is
// the single classification surface; the About page renders the badges, the
// cluster detail page renders the same badges, and the legend in About
// explains them.
//
// The chain's own operator-risk signals are consumed separately and complement
// this probe-derived view: `lyth_operatorRisk` (miss-rate / jail-status,
// MD-CORE-0006) in operator-risk-client.ts, and the `lyth_publicServiceProbe`
// probe runner (called direct behind withChainFallback).
//
// Whitepaper alignment:
//   §28.1   — Monarch OS substrate (capabilities = surfaces operator
//              chose to expose; missing surfaces don't mean operator is
//              bad, just narrower).
//   §28.2.1 — indexer staleness (drives `indexer-lag` risk).
//   §28.3.1 — diversity scoring (a future commit could derive `region-
//              concentration` risk; today's probe doesn't return that).
//   §28.3.3 — diversity-failure cluster ejection (informational link
//              from the About-page legend).

/** Possible risk classes. Each maps to a one-line "why this matters"
 *  in the About-page legend (the wallet
 *  surfaces the badges throughout). */
export type OperatorRiskKind =
  | "untrusted-genesis"
  | "quarantined"
  | "transport-error"
  | "indexer-stale"
  | "indexer-disabled"
  | "missing-capabilities"
  | "high-latency"
  | "pending-change";

/** One badge to display next to an operator row. */
export interface OperatorRiskBadge {
  kind: OperatorRiskKind;
  /** One-line user-facing label. Short — fits in a 10-char chip. */
  label: string;
  /** Tooltip explanation. One sentence. */
  tooltip: string;
  /** Severity tier; drives badge color in the UI. */
  severity: "info" | "warn" | "err";
}

/** Subset of operator-probe output this classifier needs. Mirrors
 *  `OperatorHealthRow` in popup/bg.ts but kept independent so this
 *  module has no popup-tree dependencies. */
export interface OperatorRiskInput {
  ok: boolean;
  trustedGenesis: boolean;
  /** True when the operator self-reported a -32047 "chain quarantined"
   *  (checkpoint state-root mismatch). Same chain, but excluded until it
   *  recovers — surfaced as a distinct "quarantined" badge rather than the
   *  misleading "untrusted-genesis". */
  quarantined: boolean;
  capabilities: Record<string, string> | null;
  indexerHeight: number | null;
  indexerLatest: number | null;
  latencyMs: number | null;
  /** Optional pending-change preview from a future chain reader. When
   *  null, no pending-change risk surfaces. */
  pendingChange?: {
    /** Free-form chain-supplied label, e.g. "rotation in 3 epochs". */
    summary: string;
    /** Chain-supplied severity hint. */
    severity: "info" | "warn" | "err";
  } | null;
}

/** Threshold for "high latency" — the probe budget is 4 s, so
 *  3 s + is the warning band. */
export const HIGH_LATENCY_MS = 3000;

/** Threshold for "indexer stale" — beyond this many blocks of lag the
 *  operator is flagged. Mirrors INDEXER_LAG_STALE_THRESHOLD in SW. */
export const INDEXER_STALE_LAG = 10;

/** Required capability surfaces a healthy operator should expose. Missing
 *  any of these surfaces the missing-capabilities badge. */
export const EXPECTED_CAPABILITY_SURFACES: readonly string[] = [
  "indexer_history",
];

/** Classify an operator into zero-or-more risk badges. Returns an empty
 *  array for a fully-healthy operator. */
export function classifyOperatorRisk(
  input: OperatorRiskInput,
): OperatorRiskBadge[] {
  const out: OperatorRiskBadge[] = [];

  if (!input.ok) {
    out.push({
      kind: "transport-error",
      label: "offline",
      tooltip: "Operator probe failed (network or HTTP error).",
      severity: "err",
    });
    // When the operator is unreachable the rest of the signals are
    // null; classify and return early.
    return out;
  }

  if (input.quarantined) {
    // Same chain, but the operator self-quarantined on a checkpoint state-root
    // mismatch and refuses RPC. Distinct from untrusted-genesis (different
    // chain) — the exclusion is identical, the cause is not. Mirrors the
    // send-error.ts `chain-quarantined` class.
    out.push({
      kind: "quarantined",
      label: "quarantined",
      tooltip:
        "Operator self-quarantined (checkpoint state-root mismatch) and " +
        "refuses RPC. It's on your chain but temporarily can't be trusted, " +
        "so RPC dispatch excludes it until it recovers.",
      severity: "err",
    });
  } else if (!input.trustedGenesis) {
    out.push({
      kind: "untrusted-genesis",
      label: "untrusted",
      tooltip:
        "Operator's chain genesis doesn't match the wallet's pinned genesis. " +
        "RPC dispatch excludes this operator.",
      severity: "err",
    });
  }

  if (input.capabilities === null) {
    out.push({
      kind: "missing-capabilities",
      label: "no caps",
      tooltip:
        "Operator did not respond to lyth_operatorCapabilities — may be " +
        "running a pre-uplift binary.",
      severity: "warn",
    });
  } else {
    const missing = EXPECTED_CAPABILITY_SURFACES.filter(
      (s) => !(s in input.capabilities!),
    );
    if (missing.length > 0) {
      out.push({
        kind: "missing-capabilities",
        label: `missing ${missing.length}`,
        tooltip: `Operator missing surfaces: ${missing.join(", ")}.`,
        severity: "warn",
      });
    }
  }

  if (input.indexerHeight === null) {
    out.push({
      kind: "indexer-disabled",
      label: "no indexer",
      tooltip:
        "Operator indexer disabled. Activity feed falls back to other " +
        "operators when available.",
      severity: "info",
    });
  } else if (
    input.indexerLatest !== null &&
    input.indexerLatest - input.indexerHeight > INDEXER_STALE_LAG
  ) {
    const lag = input.indexerLatest - input.indexerHeight;
    out.push({
      kind: "indexer-stale",
      label: `lag ${lag}`,
      tooltip: `Operator's indexer is ${lag} blocks behind the chain head.`,
      severity: "warn",
    });
  }

  if (input.latencyMs !== null && input.latencyMs >= HIGH_LATENCY_MS) {
    out.push({
      kind: "high-latency",
      label: `${(input.latencyMs / 1000).toFixed(1)}s`,
      tooltip:
        `Operator's probe round-trip took ${input.latencyMs} ms; healthy ` +
        `operators respond in under ${HIGH_LATENCY_MS} ms.`,
      severity: "warn",
    });
  }

  if (input.pendingChange) {
    out.push({
      kind: "pending-change",
      label: "pending",
      tooltip: input.pendingChange.summary,
      severity: input.pendingChange.severity,
    });
  }

  return out;
}

/** Legend entries for the About-page risk-glossary card. One-to-one
 *  with `OperatorRiskKind`. */
export const OPERATOR_RISK_LEGEND: ReadonlyArray<{
  kind: OperatorRiskKind;
  label: string;
  body: string;
  /** Developer-only legend entries — technical risk signals (capability /
   *  indexer / latency / pending) routed behind developer mode. The trust +
   *  reachability entries stay visible to everyone. */
  devOnly?: boolean;
}> = [
  {
    kind: "untrusted-genesis",
    label: "Untrusted genesis",
    body:
      "This operator is on a different chain — the wallet won't trust its " +
      "data and excludes it from every request.",
  },
  {
    kind: "quarantined",
    label: "Quarantined",
    body:
      "This operator reported a checkpoint state-root mismatch and refuses " +
      "RPC. It's on your chain but temporarily can't be trusted, so the " +
      "wallet excludes it until it recovers.",
  },
  {
    kind: "transport-error",
    label: "Offline / unreachable",
    body:
      "The wallet couldn't reach this operator. It's skipped automatically " +
      "— nothing for you to do.",
  },
  {
    kind: "indexer-stale",
    label: "Indexer lagging",
    body:
      "Operator's indexer is more than 10 blocks behind the chain head. " +
      "Activity history fetched from this operator may miss recent " +
      "transactions until it catches up.",
    devOnly: true,
  },
  {
    kind: "indexer-disabled",
    label: "No indexer",
    body:
      "Operator does not serve the indexer endpoint. The activity feed " +
      "falls back to another operator when one is configured.",
    devOnly: true,
  },
  {
    kind: "missing-capabilities",
    label: "Capability surface gaps",
    body:
      "Operator is missing capability surfaces the wallet expects " +
      "(indexer_history, etc.). Often means a pre-uplift " +
      "binary; not load-bearing for basic sends.",
    devOnly: true,
  },
  {
    kind: "high-latency",
    label: "High latency",
    body:
      "Operator's probe round-trip exceeded 3 seconds. The wallet " +
      "tolerates it (operator failover kicks in on real RPC errors) " +
      "but routine reads may feel sluggish.",
    devOnly: true,
  },
  {
    kind: "pending-change",
    label: "Pending operator change",
    body:
      "Chain registry reports a pending config / key / cluster change " +
      "for this operator. Severity is chain-supplied; informational only " +
      "— the wallet does nothing automatic.",
    devOnly: true,
  },
];

/** B3 — the user-facing reason to BLOCK a manual "use this operator" connect,
 *  or `null` when the operator is connectable. An err-severity risk badge
 *  (untrusted-genesis / quarantined / transport-error) blocks the switch; the
 *  message is pulled from the same legend the badge explains, so the block copy
 *  matches what the user already sees on the operator row. Pure + testable.
 *
 *  This is a UI guard so the wallet never *pins* a bad operator — the real
 *  security boundary is RPC dispatch, which re-verifies every operator's
 *  genesis on every call regardless of the override order. */
export function operatorConnectBlockReason(
  input: OperatorRiskInput,
): string | null {
  const blocker = classifyOperatorRisk(input).find((b) => b.severity === "err");
  if (!blocker) return null;
  const legend = OPERATOR_RISK_LEGEND.find((e) => e.kind === blocker.kind);
  return legend?.body ?? blocker.tooltip;
}
