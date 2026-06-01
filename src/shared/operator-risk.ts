// Phase 11 Commit 5 — operator risk classification.
//
// Chain commit 017cab9 ("Operator pending-change risk previews")
// shipped server-side preview computation; the SDK at @0fd8a79 doesn't
// yet expose a typed helper. Chain commit 7160636 ("Registry public
// service probe runner") added probe-result data that an
// `lyth_publicServiceProbe` reader would surface.
//
// Until those readers land in the SDK, the wallet derives risk flags
// from the data the per-operator probe already collects (Phase 7.1):
// genesis verification, capability surface, indexer lag, latency, error
// state. This module is the single classification surface; the About
// page renders the badges, the cluster detail page (Commit 6) renders
// the same badges, and the legend in About explains them.
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
 *  in the About-page legend (Commit 5 ships the legend; the wallet
 *  surfaces the badges throughout). */
export type OperatorRiskKind =
  | "untrusted-genesis"
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

/** Threshold for "high latency" — Phase 7.1 probe budget is 4 s, so
 *  3 s + is the warning band. */
export const HIGH_LATENCY_MS = 3000;

/** Threshold for "indexer stale" — beyond this many blocks of lag the
 *  operator is flagged. Mirrors INDEXER_LAG_STALE_THRESHOLD in SW. */
export const INDEXER_STALE_LAG = 10;

/** Required capability surfaces a healthy operator should expose. Missing
 *  any of these surfaces the missing-capabilities badge. */
export const EXPECTED_CAPABILITY_SURFACES: readonly string[] = [
  "ferveo",
  "indexer",
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

  if (!input.trustedGenesis) {
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
}> = [
  {
    kind: "untrusted-genesis",
    label: "Untrusted genesis",
    body:
      "Operator's chain genesis doesn't match the wallet's pinned " +
      "Sprintnet genesis. The wallet's RPC dispatcher excludes operators " +
      "with mismatched genesis (GAP #11 orphan-fork defense).",
  },
  {
    kind: "transport-error",
    label: "Offline / unreachable",
    body:
      "Operator's probe failed at the transport layer (network error, " +
      "HTTP 4xx/5xx, or RPC timeout). Wallet routes around it; user " +
      "doesn't need to take action.",
  },
  {
    kind: "indexer-stale",
    label: "Indexer lagging",
    body:
      "Operator's indexer is more than 10 blocks behind the chain head. " +
      "Activity history fetched from this operator may miss recent " +
      "transactions until it catches up.",
  },
  {
    kind: "indexer-disabled",
    label: "No indexer",
    body:
      "Operator does not serve the indexer endpoint. The activity feed " +
      "falls back to another operator when one is configured.",
  },
  {
    kind: "missing-capabilities",
    label: "Capability surface gaps",
    body:
      "Operator is missing capability surfaces the wallet expects " +
      "(ferveo encrypted-mempool, indexer, etc.). Often means a pre-uplift " +
      "binary; not load-bearing for basic sends.",
  },
  {
    kind: "high-latency",
    label: "High latency",
    body:
      "Operator's probe round-trip exceeded 3 seconds. The wallet " +
      "tolerates it (operator failover kicks in on real RPC errors) " +
      "but routine reads may feel sluggish.",
  },
  {
    kind: "pending-change",
    label: "Pending operator change",
    body:
      "Chain registry reports a pending config / key / cluster change " +
      "for this operator (chain commit 017cab9 risk-preview). Severity " +
      "is chain-supplied; informational only — the wallet does nothing " +
      "automatic.",
  },
];
