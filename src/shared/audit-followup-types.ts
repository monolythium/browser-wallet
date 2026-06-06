// Audit follow-up: typed response shapes for new lyth_*
// reader methods landed on mono-core @dd05511 (sync log
// docs/chain-sync-log.md).
//
// The TS SDK at mono-core-sdk @0fd8a79 did NOT move and exposes no
// typed wrappers for any of these methods yet, so the wallet calls
// them via the existing `testnetJsonRpc` + `withChainFallback`
// pattern. This module captures the field-for-field response shapes
// (mirroring Rust serde rename_all = "camelCase") plus thin runtime
// validators usable as `withChainFallback`'s `isValid` callback.
//
// Each validator is intentionally loose — it checks structural shape
// (required keys + obvious type kinds) but tolerates unknown extra
// fields and unrecognized enum variants (the Rust side has explicit
// forward-compat: SigningEntryStatus::Unknown(String) +
// supported_statuses[] capability flag).
//
// CHAIN GAP TRACKER
// =================
//
// Follow-up RPCs investigated:
//
// 1. **Delegation reward claim ledger** — the wallet now calls
//    `lyth_pendingRewards` directly in `staking-client.ts`. Typed SDK
//    helpers may replace that direct call once the wallet consumes a
//    package release carrying the new reader.
//
// 2. **`lyth_setAddressLabel`** — the `lyth_getAddressLabel`
//    handler (`protocore.rs:3660`) comments that the indexer
//    adapter "powers a future `lyth_setAddressLabel` admin RPC",
//    but the write path is not wired. Wallet's address-book write
//    flow (originally proposed) is deferred.
//
// Remaining deferred items will be re-evaluated at the next chain sync.
//
// Whitepaper alignment:
//  - lyth_previewTransactionHooks → §15 (spending policy hook gate)
//  - lyth_signingActivity         → §21.4 (BLS block-tier finality)
//                                   + MD-CORE-0004 reserved-status
//  - lyth_getServiceProbe         → §29.5 (operator availability)
//  - lyth_upcomingDuties          → §21.4 + §23 (delegator
//                                   transparency for committee
//                                   participation)
//
// Numeric width note: u64 round counts and block heights are
// modelled as `number` to match existing wallet conventions
// (e.g. blockHeight in PendingRewardsView). All chain values we
// care about stay well below 2^53 for the foreseeable future.

// ---------------------------------------------------------------
// 1) lyth_previewTransactionHooks   (MS-CORE-0009 / 13fb4ceb)
//    Handler: protocore.rs:576
//    Params:  [CallRequest, BlockId?]
// ---------------------------------------------------------------

/** Severity strings the chain currently emits for a hook warning.
 *  String-typed (not enum) because new severities can be added
 *  on the chain side without breaking the wallet. */
export type TransactionHookSeverity = "info" | "warning" | "error" | string;

export interface TransactionHookWarning {
  code: string;
  severity: TransactionHookSeverity;
  message: string;
}

/** Subset of the spending-policy hook (`§15`) preview surface. The
 *  chain's `SpendingPolicyHookPreview` has skip_serializing_if on
 *  the four Option<> fields, so they may be absent on the wire. */
export interface SpendingPolicyHookPreview {
  status: string;
  reason?: string;
  wireCode?: number;
  message?: string;
  details: Record<string, string>;
}

export interface TransactionHookPreview {
  schemaVersion: number;
  wouldReject: boolean;
  warnings: TransactionHookWarning[];
  spendingPolicy: SpendingPolicyHookPreview;
}

export function isTransactionHookPreview(raw: unknown): raw is TransactionHookPreview {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.schemaVersion !== "number") return false;
  if (typeof o.wouldReject !== "boolean") return false;
  if (!Array.isArray(o.warnings)) return false;
  for (const w of o.warnings) {
    if (!w || typeof w !== "object") return false;
    const wo = w as Record<string, unknown>;
    if (typeof wo.code !== "string") return false;
    if (typeof wo.severity !== "string") return false;
    if (typeof wo.message !== "string") return false;
  }
  if (!o.spendingPolicy || typeof o.spendingPolicy !== "object") return false;
  const sp = o.spendingPolicy as Record<string, unknown>;
  if (typeof sp.status !== "string") return false;
  if (sp.details === undefined || typeof sp.details !== "object" || sp.details === null) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------
// 2) lyth_signingActivity   (MD-CORE-0004 / d7f0640c et al)
//    Handler: protocore.rs:3003
//    Params:  [authorityIndex: u16, limit?: u32 (default 200)]
// ---------------------------------------------------------------

/** Canonical SigningEntryStatus codes emitted by the chain today.
 *  The chain's Rust enum has `Unknown(String)` fall-through, so
 *  the wallet must accept any string here — anything not in the
 *  known set is treated as "unknown" by the UI. */
export const KNOWN_SIGNING_ENTRY_STATUSES = [
  "signed",
  "missed",
  "delayed",
  "offline",
  "maintenance",
  "no_cert",
  "unavailable_history",
] as const;
export type SigningEntryStatus = (typeof KNOWN_SIGNING_ENTRY_STATUSES)[number] | string;

export interface OperatorSigningEntry {
  round: number;
  status: SigningEntryStatus;
  /** Present only when the cert exists (Signed/Delayed/Offline/
   *  Maintenance/Missed); omitted for NoCert/UnavailableHistory. */
  signersCount?: number;
}

export interface SigningActivityArchiveRedirect {
  hint: string;
}

export interface SigningActivityRetention {
  earliestRetained: number;
  archiveRedirect?: SigningActivityArchiveRedirect;
}

/** A reserved-status code the operator can emit but for which the
 *  underlying primitive isn't fully wired yet. Surfaced verbatim in
 *  dev-tools so we can see when a subsystem catches up. */
export interface ReservedStatusInfo {
  code: string;
  missingPrimitive: string;
  responsibleSubsystem: string;
  description: string;
}

export interface OperatorSigningActivity {
  schemaVersion: number;
  authorityIndex: number;
  currentRound: number;
  limit: number;
  /** Which status codes this node CAN emit. Forward-compat flag —
   *  if a status the wallet doesn't recognize appears, it means the
   *  chain rolled out a new code we haven't shipped UI for yet. */
  supportedStatuses: string[];
  retention?: SigningActivityRetention;
  reservedStatuses: ReservedStatusInfo[];
  entries: OperatorSigningEntry[];
}

export function isOperatorSigningActivity(raw: unknown): raw is OperatorSigningActivity {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.schemaVersion !== "number") return false;
  if (typeof o.authorityIndex !== "number") return false;
  if (typeof o.currentRound !== "number") return false;
  if (typeof o.limit !== "number") return false;
  if (!Array.isArray(o.supportedStatuses)) return false;
  for (const s of o.supportedStatuses) if (typeof s !== "string") return false;
  if (!Array.isArray(o.reservedStatuses)) return false;
  for (const r of o.reservedStatuses) {
    if (!r || typeof r !== "object") return false;
    const ro = r as Record<string, unknown>;
    if (typeof ro.code !== "string") return false;
    if (typeof ro.missingPrimitive !== "string") return false;
    if (typeof ro.responsibleSubsystem !== "string") return false;
    if (typeof ro.description !== "string") return false;
  }
  if (!Array.isArray(o.entries)) return false;
  for (const e of o.entries) {
    if (!e || typeof e !== "object") return false;
    const eo = e as Record<string, unknown>;
    if (typeof eo.round !== "number") return false;
    if (typeof eo.status !== "string") return false;
    if (eo.signersCount !== undefined && typeof eo.signersCount !== "number") return false;
  }
  return true;
}

/** Roll-up across an entries[] window: which status appears most
 *  recently, plus a coarse "health" classifier the UI maps onto a
 *  pill color. Helper rather than chain field — derived view. */
export function summarizeSigningActivity(
  activity: OperatorSigningActivity,
): { latestStatus: SigningEntryStatus; latestSignersCount: number | null; isHealthy: boolean } {
  const entries = activity.entries;
  if (entries.length === 0) {
    return { latestStatus: "unavailable_history", latestSignersCount: null, isHealthy: false };
  }
  // entries are returned newest-first per chain convention; defend
  // either way by picking the highest round.
  let latest = entries[0]!;
  for (const e of entries) if (e.round > latest.round) latest = e;
  const healthy = latest.status === "signed" || latest.status === "maintenance";
  return {
    latestStatus: latest.status,
    latestSignersCount: latest.signersCount ?? null,
    isHealthy: healthy,
  };
}

// ---------------------------------------------------------------
// 2b) lyth_operatorRisk   (MD-CORE-0006 / 017cab9)
//     Handler: ChainProvider::operator_risk → returns OperatorRisk
//     Params:  [authorityIndex: u16, windowRounds: u32]
//              (windowRounds clamped at MAX_OPERATOR_RISK_WINDOW = 1000)
//
// Wired in Commit 5 INSTEAD OF lyth_getServiceProbe (the original
// task spec). Rationale documented in the audit follow-up commit
// message: the wallet's Operators page surfaces RPC URLs, not the
// 32-byte node-registry peerIds that lyth_getServiceProbe requires.
// lyth_operatorRisk is the sibling MD-CORE-0006 surface that delivers
// the same "real chain-side operator health" intent without needing
// a separate peerId-resolution chain. It also slots into the existing
// `pendingChange` placeholder on operator-risk.ts:59-66.
// ---------------------------------------------------------------

export type JailStatusWindow =
  | {
      jailed: boolean;
      tombstoned: boolean;
      jailedUntilHeight: number;
      unjailCount: number;
    }
  | { reason: string };

export interface OperatorRiskWire {
  schemaVersion: number;
  authorityIndex: number;
  dataHeight: number;
  windowRounds: number;
  missedRounds: number;
  observedRounds: number;
  missRateBps: number;
  thresholdBps: number;
  remainingHeadroomBps: number;
  jailStatus: JailStatusWindow;
  reasons: string[];
}

export function isOperatorRiskWire(raw: unknown): raw is OperatorRiskWire {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  for (const k of [
    "schemaVersion",
    "authorityIndex",
    "dataHeight",
    "windowRounds",
    "missedRounds",
    "observedRounds",
    "missRateBps",
    "thresholdBps",
    "remainingHeadroomBps",
  ] as const) {
    if (typeof o[k] !== "number") return false;
  }
  if (!Array.isArray(o.reasons)) return false;
  for (const r of o.reasons) if (typeof r !== "string") return false;
  const js = o.jailStatus;
  if (!js || typeof js !== "object") return false;
  const jso = js as Record<string, unknown>;
  const isAvailable =
    typeof jso.jailed === "boolean" &&
    typeof jso.tombstoned === "boolean" &&
    typeof jso.jailedUntilHeight === "number" &&
    typeof jso.unjailCount === "number";
  const isAbsent = typeof jso.reason === "string";
  if (!isAvailable && !isAbsent) return false;
  return true;
}

export function isJailStatusAvailable(
  js: JailStatusWindow,
): js is {
  jailed: boolean;
  tombstoned: boolean;
  jailedUntilHeight: number;
  unjailCount: number;
} {
  return "jailed" in js;
}

/** Risk tier derived from the chain's miss-rate vs threshold. Drives
 *  the AuthorityRiskCard badge color in the popup. */
export type OperatorRiskTier = "ok" | "warn" | "err";

/** Map a chain-side OperatorRiskWire payload onto a coarse 3-tier
 *  badge class. Pure derivation — kept in the shared module so the
 *  popup can use it without importing the SW-side RPC client. */
export function deriveOperatorRiskTier(risk: OperatorRiskWire): OperatorRiskTier {
  if (
    "jailed" in risk.jailStatus &&
    (risk.jailStatus.jailed || risk.jailStatus.tombstoned)
  ) {
    return "err";
  }
  if (risk.thresholdBps === 0) return "ok";
  if (risk.missRateBps >= risk.thresholdBps) return "err";
  if (risk.remainingHeadroomBps < risk.thresholdBps / 4) return "warn";
  if (risk.reasons.length > 0) return "warn";
  return "ok";
}

// ---------------------------------------------------------------
// 3) lyth_getServiceProbe   (AUD-0088 / 2a06c291)
//    Handler: protocore.rs:403
//    Params:  [peerId: [u8; 32], serviceMask: u32]
//    Returns: PublicServiceProbe | null  (null = no report for mask)
// ---------------------------------------------------------------

export interface PublicServiceProbe {
  serviceMask: number;
  status: string;
  statusCode: number;
  lastProbeBlock: number;
  latencyMs: number;
  probeDigest: string;
  reporter: string;
}

export function isPublicServiceProbe(raw: unknown): raw is PublicServiceProbe {
  if (raw === null) return false; // null means "no report" — caller handles separately
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.serviceMask !== "number") return false;
  if (typeof o.status !== "string") return false;
  if (typeof o.statusCode !== "number") return false;
  if (typeof o.lastProbeBlock !== "number") return false;
  if (typeof o.latencyMs !== "number") return false;
  if (typeof o.probeDigest !== "string") return false;
  if (typeof o.reporter !== "string") return false;
  return true;
}

// ---------------------------------------------------------------
// 4) lyth_upcomingDuties   (MD-CORE-0005 partial / 026d925a + others)
//    Handler: protocore.rs:3184
//    Params:  [authorityIndex: u16, horizonRounds?: u32]
// ---------------------------------------------------------------

export interface CommitteeContext {
  authoritySetSize: number;
  quorumThreshold: number;
  recoveryFloor: number;
  authorityInCurrentSet: boolean;
}

export interface AttestationWindow {
  startRound: number;
  endRound: number;
  kind: string;
}

export interface DutyAbsence {
  reason: string;
  state?: string;
  currentLag?: number;
  syncThresholdRounds?: number;
  probeIntervalMs?: number;
  catchingIntervalMs?: number;
}

/** Untagged enum on the chain side — distinguish by `nextRound`
 *  vs `reason` presence. */
export type KeyRotationWindow =
  | { nextRound: number; epochLengthRounds: number }
  | { reason: string };

export interface UpcomingDutyMap {
  attestation: AttestationWindow;
  blockProduction: DutyAbsence;
  sync: DutyAbsence;
  keyRotation: KeyRotationWindow;
}

export interface UpcomingDuties {
  schemaVersion: number;
  authorityIndex: number;
  currentRound: number;
  horizonRounds: number;
  committee?: CommitteeContext;
  duties: UpcomingDutyMap;
}

export function isUpcomingDuties(raw: unknown): raw is UpcomingDuties {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.schemaVersion !== "number") return false;
  if (typeof o.authorityIndex !== "number") return false;
  if (typeof o.currentRound !== "number") return false;
  if (typeof o.horizonRounds !== "number") return false;
  if (!o.duties || typeof o.duties !== "object") return false;
  const d = o.duties as Record<string, unknown>;
  if (!d.attestation || typeof d.attestation !== "object") return false;
  const att = d.attestation as Record<string, unknown>;
  if (typeof att.startRound !== "number") return false;
  if (typeof att.endRound !== "number") return false;
  if (typeof att.kind !== "string") return false;
  for (const k of ["blockProduction", "sync"] as const) {
    const v = d[k];
    if (!v || typeof v !== "object") return false;
    if (typeof (v as Record<string, unknown>).reason !== "string") return false;
  }
  const kr = d.keyRotation;
  if (!kr || typeof kr !== "object") return false;
  const kro = kr as Record<string, unknown>;
  const isAvailable = typeof kro.nextRound === "number" && typeof kro.epochLengthRounds === "number";
  const isAbsent = typeof kro.reason === "string";
  if (!isAvailable && !isAbsent) return false;
  return true;
}

/** True iff the key-rotation duty is in its scheduling-available branch. */
export function isKeyRotationAvailable(
  kr: KeyRotationWindow,
): kr is { nextRound: number; epochLengthRounds: number } {
  return "nextRound" in kr;
}
