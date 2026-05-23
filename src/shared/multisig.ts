// Phase 8 — N-of-M multisig types + pure helpers (§28.5 Q70 + Q75).
//
// What this module owns
// =====================
// Pure types + algorithms for the wallet's multisig surface. No
// `chrome.storage`, no `fetch`, no module-scope state — every helper
// here is deterministic + testable in vitest without browser shims.
// The storage round-trip lives in keystore-mldsa.ts (per-vault VEK,
// container persistence); the IPC dispatch lives in service-worker.ts;
// the UI lives in popup/.
//
// On-chain reality (investigation 2026-05-16)
// ===========================================
// mono-core @ce93d83 has NO general-purpose user-multisig precompile.
// The `0x110x` block is allocated end-to-end (emergency-key, VRF,
// streaming, cluster-name, agent-commerce primitives, escrow, arbiter,
// hierarchical name-registry) and "foundation_multisig" is the runtime-
// internal 3-of-5 ML-DSA-65 roster used for treasury / protocol-upgrade
// paths — it is NOT exposed to user accounts. ML-DSA-65 itself has no
// production-grade threshold or aggregation variant. mono-core-sdk has
// zero multisig surface.
//
// Consequence: v1 wallet multisig is **off-chain coordinated, single-
// executor on-submit**. The wallet enforces the M-of-N policy at the
// UI/IPC boundary — proposals collect M ML-DSA-65 signatures over a
// canonical proposal hash, then a designated executor signer signs +
// submits the underlying EVM transaction with its own single-key
// envelope. The other (M-1) signatures stay in the proposal record as
// an off-chain audit trail. A user who bypasses the wallet UI and uses
// the executor's seed manually CAN bypass the policy; this is a
// **chain GAP** (`TODO: chain GAP — needs Nayiem`) — a user-multisig
// precompile that verifies M-of-N pubkey signatures against an on-
// chain signer roster would close it.
//
// Cross-signer coordination is also off-chain: pending proposals live
// in chrome.storage.local under the per-vault container, and the
// shared-export helper (`exportProposalForSharing` / `importSharedProposal`,
// Commit 7) lets signers ship a proposal blob to a co-signer who is not
// in the same browser profile. Same caveat: the chain does not know
// about pending proposals — it only sees the final single-signer tx.
//
// Whitepaper alignment
// ====================
// §28.5 Q70 — configurable 1-of-1 through N-of-M, signers nameable.
// §28.5 Q75 — signers changeable post-creation via existing-signer
//             approval (an M-of-current-signers governance vote).
// §21.2.1   — each signer's keypair is the same PQM-1 ML-DSA-65 seed
//             a regular vault uses; "self" signers reference a vault
//             inside the same VaultsContainerV4. "external" signers
//             are pubkeys without a local secret — they can vote via
//             the shared-proposal import path.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

// ────────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────────

/** Hard cap on signers per multisig vault. Picked to keep proposal
 *  records human-reviewable in the popup; the on-chain story (when a
 *  precompile lands) will likely pin a tighter bound. */
export const MAX_SIGNERS = 16;

/** Default lifetime of a transaction proposal — 7 days. Picked to
 *  cover a typical "team rotation" without leaving stale proposals
 *  forever. The popup surfaces remaining time per row. */
export const DEFAULT_TX_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Default lifetime of a governance proposal — 14 days. Governance
 *  decisions (signer changes, threshold changes) move slower than tx
 *  approvals; the longer window lets a quorum form across timezones
 *  without pressure to rush. */
export const DEFAULT_GOV_PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Domain tag mixed into every proposal hash. Distinct prefixes for
 *  tx vs governance keep the two signature surfaces cryptographically
 *  separate — a signature over a tx proposal cannot be replayed as
 *  approval of a governance proposal even if the inner payload bytes
 *  happen to collide. */
const TX_HASH_DOMAIN = "mono-wallet-multisig-tx-v1";
const GOV_HASH_DOMAIN = "mono-wallet-multisig-gov-v1";

// ────────────────────────────────────────────────────────────────────────────
// Signer + vault metadata
// ────────────────────────────────────────────────────────────────────────────

/** A single multisig signer. Two roles:
 *
 *   - `"self"`  — the signer's ML-DSA-65 keypair lives in another
 *                 vault in the same VaultsContainerV4. `vaultId`
 *                 points at that vault; the wallet can produce the
 *                 signer's approval signature locally after the user
 *                 unlocks the container.
 *
 *   - `"external"` — the signer's secret is held outside this wallet.
 *                 Only the pubkey + address are stored; approvals
 *                 arrive via the shared-proposal import path
 *                 (Commit 7). Cannot be auto-signed by this wallet.
 */
export interface MultisigSigner {
  /** Stable id used by proposals to reference this signer. Generated
   *  with crypto.randomUUID() at vault creation; never reused. */
  id: string;
  /** User-facing label (1-32 chars after trim). Defaults to
   *  `"Signer N"` when the user does not supply one. */
  label: string;
  /** EVM-style hex address (0x + 40 hex), derived from the pubkey via
   *  keccak256(pubkey)[12..32] — same derivation a regular vault uses. */
  address: string;
  /** 0x-prefixed hex of the 1952-byte ML-DSA-65 public key. Required
   *  to verify approval signatures; cached here so the popup can
   *  render the signer without unlocking the container. */
  pubkey: string;
  role: "self" | "external";
  /** When `role === "self"`: id of the vault inside this container
   *  whose seed produces the signer's keypair. Undefined for
   *  external signers. */
  vaultId?: string;
}

/** Metadata embedded inside a multisig vault record. The vault itself
 *  is still a VaultRecordV4 with a wrappedKey + envelope (Phase 5
 *  layer); this block carries the M-of-N policy + proposal queues.
 *
 *  The vault's own keypair (the one decrypted from its envelope) is
 *  what submits executable proposals on-chain — it is the multisig
 *  vault's "account". Each signer's separate keypair is for approval
 *  signatures, not for chain submission. */
export interface MultisigVaultMeta {
  signers: MultisigSigner[];
  threshold: number;
  /** Pending transaction proposals — awaiting signatures, ready to
   *  execute, or terminal (executed / rejected / expired). The popup
   *  filters by status; persisted records age out per
   *  DEFAULT_TX_PROPOSAL_TTL_MS. */
  proposals: PendingProposal[];
  /** Pending governance proposals — add/remove/replace signer or
   *  change threshold. Same lifecycle pattern as `proposals`. */
  governance: GovernanceProposal[];
}

/** Signature record over a proposal hash. The signature is ML-DSA-65
 *  (~3309 bytes); we store it hex-encoded for chrome.storage round-trip
 *  and parse-on-verify. */
export interface ProposalSignature {
  signerId: string;
  /** 0x-prefixed hex of the ML-DSA-65 signature bytes. */
  signature: string;
  signedAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Transaction proposals
// ────────────────────────────────────────────────────────────────────────────

/** What a proposal asks the multisig vault to execute. Two variants
 *  for v1 — native LYTH send and contract call — both lower to a
 *  single `bgWalletSendTx` invocation at execution time. */
export type ProposalAction =
  | {
      kind: "send";
      /** Recipient (0x... or bech32m display form; lowercased before hashing). */
      to: string;
      /** Compatibility field name; hex lythoshi native value (0x...). */
      valueWeiHex: string;
      chainIdHex: string;
      /** Optional EVM calldata for an ERC-20 / NFT transfer initiated
       *  through the multisig. Omitted for plain LYTH sends. */
      data?: string;
      gasLimitHex?: string;
    }
  | {
      kind: "contract";
      to: string;
      data: string;
      chainIdHex: string;
      valueWeiHex?: string;
      gasLimitHex?: string;
    };

export type ProposalStatus = "pending" | "executed" | "rejected" | "expired";

export interface PendingProposal {
  id: string;
  /** id of the signer that created the proposal. The proposer's
   *  approval is implicit and gets recorded in `approvals` at
   *  creation time so the M-of-N count is honest. */
  proposedBy: string;
  createdAt: number;
  expiresAt: number;
  /** Vault address the proposal targets — captured at creation so a
   *  signer reviewing the proposal blob (off-band) can validate it
   *  matches the multisig vault they expect. */
  vaultAddress: string;
  action: ProposalAction;
  approvals: ProposalSignature[];
  rejections: ProposalSignature[];
  status: ProposalStatus;
  /** Tx hash from `bgWalletSendTx` once executed; null until then or
   *  when status is not `"executed"`. */
  txHash: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Governance proposals (§28.5 Q75)
// ────────────────────────────────────────────────────────────────────────────

export type GovernanceAction =
  | { kind: "add-signer"; signer: Omit<MultisigSigner, "id"> }
  | { kind: "remove-signer"; signerId: string }
  | {
      kind: "replace-signer";
      signerId: string;
      replacement: Omit<MultisigSigner, "id">;
    }
  | { kind: "change-threshold"; threshold: number };

export type GovernanceStatus = "pending" | "applied" | "rejected" | "expired";

export interface GovernanceProposal {
  id: string;
  proposedBy: string;
  createdAt: number;
  expiresAt: number;
  vaultAddress: string;
  action: GovernanceAction;
  approvals: ProposalSignature[];
  rejections: ProposalSignature[];
  status: GovernanceStatus;
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────

/** Find the first self-signer in a roster — the one whose ML-DSA-65
 *  keypair lives in a vault inside this container. Used by the
 *  multisig propose/sign IPC paths to pick a default proposer/approver
 *  when the user doesn't supply an explicit signer id. Returns
 *  undefined when the roster is all-external (the wallet cannot
 *  propose locally and must surface "no local signer available" UX).
 *
 *  Commit 4 introduces a multi-self-signer picker; the v1 default
 *  "first match" suffices for the common one-self-signer case. */
export function pickFirstSelfSigner(
  signers: readonly MultisigSigner[],
): MultisigSigner | undefined {
  return signers.find((s) => s.role === "self" && s.vaultId !== undefined);
}

/** Find the first self-signer who has NOT already voted on the
 *  proposal (neither approved nor rejected). Used by the sign/reject
 *  IPC handlers to pick the next local signer that can still vote;
 *  returns undefined when every local signer has already voted or
 *  when there are no self-signers at all. */
export function pickNextLocalVoter(
  signers: readonly MultisigSigner[],
  approvedIds: ReadonlySet<string>,
  rejectedIds: ReadonlySet<string>,
): MultisigSigner | undefined {
  return signers.find(
    (s) =>
      s.role === "self" &&
      s.vaultId !== undefined &&
      !approvedIds.has(s.id) &&
      !rejectedIds.has(s.id),
  );
}

/** Default threshold for an N-signer multisig — simple majority
 *  (floor(N/2) + 1). The spec calls this out as the default; users
 *  can override at creation time. Concrete values:
 *
 *    N=1 → 1, N=2 → 2, N=3 → 2, N=4 → 3, N=5 → 3, N=6 → 4, N=7 → 4.
 */
export function defaultThreshold(signerCount: number): number {
  if (signerCount < 1) throw new Error("signerCount must be >= 1");
  return Math.floor(signerCount / 2) + 1;
}

/** Validate a (threshold, signerCount) pair. The wallet rejects
 *  thresholds outside [1, N] and beyond MAX_SIGNERS, with the
 *  message exposed in IPC error.reason. */
export function validateThreshold(
  threshold: number,
  signerCount: number,
): void {
  if (!Number.isInteger(threshold)) {
    throw new Error("threshold must be an integer");
  }
  if (!Number.isInteger(signerCount)) {
    throw new Error("signerCount must be an integer");
  }
  if (signerCount < 1) throw new Error("at least one signer is required");
  if (signerCount > MAX_SIGNERS) {
    throw new Error(`at most ${MAX_SIGNERS} signers are supported`);
  }
  if (threshold < 1) throw new Error("threshold must be >= 1");
  if (threshold > signerCount) {
    throw new Error("threshold cannot exceed signer count");
  }
}

/** Validate a signer's externally-supplied fields. Used by creation +
 *  governance "add-signer". Does NOT validate uniqueness — caller is
 *  responsible for the set-level check against the existing roster
 *  (`assertSignerSetUnique` below). */
export function validateSignerInput(
  signer: Omit<MultisigSigner, "id">,
): void {
  const trimmedLabel = signer.label.trim();
  if (trimmedLabel.length === 0) {
    throw new Error("signer label must be non-empty");
  }
  if (trimmedLabel.length > 32) {
    throw new Error("signer label must be 1-32 characters");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer.address)) {
    throw new Error("signer address must be 0x + 40 hex chars");
  }
  // ML-DSA-65 public key is 1952 bytes → 3904 hex chars + 2 prefix.
  if (!/^0x[0-9a-fA-F]{3904}$/.test(signer.pubkey)) {
    throw new Error("signer pubkey must be 0x + 3904 hex chars (1952 bytes)");
  }
  if (signer.role !== "self" && signer.role !== "external") {
    throw new Error("signer role must be 'self' or 'external'");
  }
  if (signer.role === "self" && !signer.vaultId) {
    throw new Error("self-role signer must reference a local vault id");
  }
  if (signer.role === "external" && signer.vaultId !== undefined) {
    throw new Error("external-role signer must not carry a vaultId");
  }
}

/** Assert no two signers share an address or vaultId. Whitepaper
 *  Q70 implies one-signer-one-vote, so duplicates would silently
 *  degrade the M-of-N security model. */
export function assertSignerSetUnique(signers: MultisigSigner[]): void {
  const addresses = new Set<string>();
  const vaultIds = new Set<string>();
  for (const s of signers) {
    const lower = s.address.toLowerCase();
    if (addresses.has(lower)) {
      throw new Error(`duplicate signer address: ${s.address}`);
    }
    addresses.add(lower);
    if (s.vaultId !== undefined) {
      if (vaultIds.has(s.vaultId)) {
        throw new Error(`duplicate signer vaultId: ${s.vaultId}`);
      }
      vaultIds.add(s.vaultId);
    }
  }
}

/** Canonical proposal hash. Both signers and verifiers compute this
 *  the same way: a stable JSON-ish string with sorted keys + the
 *  domain tag prefix, then keccak256. The output is what every signer
 *  signs over with ML-DSA-65.
 *
 *  Why not JCS proper: this hash is wallet-local — it never crosses
 *  the chain boundary, so the simpler `canonicalStringify` here
 *  (sorted keys, no whitespace, no Unicode normalization beyond
 *  JSON.stringify defaults) is fine and ~50× smaller than pulling
 *  in a JCS dependency. The domain tag prefix is what binds the
 *  hash to "this is a Monolythium-wallet multisig vN proposal" so a
 *  future schema bump can rotate the tag and invalidate stale
 *  signatures cleanly. */
export function hashTxProposal(p: PendingProposal): Uint8Array {
  const body = canonicalStringify({
    domain: TX_HASH_DOMAIN,
    proposalId: p.id,
    vaultAddress: p.vaultAddress.toLowerCase(),
    action: normalizeAction(p.action),
  });
  return keccak_256(new TextEncoder().encode(body));
}

export function hashGovernanceProposal(p: GovernanceProposal): Uint8Array {
  const body = canonicalStringify({
    domain: GOV_HASH_DOMAIN,
    proposalId: p.id,
    vaultAddress: p.vaultAddress.toLowerCase(),
    action: normalizeGovernanceAction(p.action),
  });
  return keccak_256(new TextEncoder().encode(body));
}

/** True when a proposal has collected enough approvals to execute.
 *  Rejected/expired/executed proposals always return false. */
export function isExecutable(
  proposal: PendingProposal,
  threshold: number,
  now: number,
): boolean {
  if (proposal.status !== "pending") return false;
  if (proposal.expiresAt <= now) return false;
  if (proposal.rejections.length >= threshold) return false;
  return proposal.approvals.length >= threshold;
}

/** True when a governance proposal has collected enough approvals. */
export function isGovernanceExecutable(
  proposal: GovernanceProposal,
  threshold: number,
  now: number,
): boolean {
  if (proposal.status !== "pending") return false;
  if (proposal.expiresAt <= now) return false;
  if (proposal.rejections.length >= threshold) return false;
  return proposal.approvals.length >= threshold;
}

/** Compute the new status of a stale proposal. Pure — caller folds
 *  the result back into storage. Returns the original status when
 *  nothing changed. */
export function reconcileProposalStatus(
  proposal: PendingProposal,
  threshold: number,
  now: number,
): ProposalStatus {
  if (proposal.status !== "pending") return proposal.status;
  if (proposal.rejections.length >= threshold) return "rejected";
  if (proposal.expiresAt <= now) return "expired";
  return "pending";
}

export function reconcileGovernanceStatus(
  proposal: GovernanceProposal,
  threshold: number,
  now: number,
): GovernanceStatus {
  if (proposal.status !== "pending") return proposal.status;
  if (proposal.rejections.length >= threshold) return "rejected";
  if (proposal.expiresAt <= now) return "expired";
  return "pending";
}

/** Apply a governance action to a (signers, threshold) pair, returning
 *  the post-application state. Pure — caller writes the result back
 *  into the vault record. Throws on rule violations (e.g. removing a
 *  signer would leave the roster below the current threshold).
 *
 *  Rules:
 *    - add-signer:        new signer must pass `validateSignerInput`;
 *                         post-add roster must be unique + <= MAX_SIGNERS.
 *    - remove-signer:     target must exist; post-remove count must
 *                         be >= threshold (so the multisig remains
 *                         self-consistent).
 *    - replace-signer:    target must exist; replacement must pass
 *                         validation; post-replace roster unique.
 *    - change-threshold:  new threshold must be in [1, N]. */
export function applyGovernance(
  signers: MultisigSigner[],
  threshold: number,
  action: GovernanceAction,
  newSignerId: () => string,
): { signers: MultisigSigner[]; threshold: number } {
  switch (action.kind) {
    case "add-signer": {
      validateSignerInput(action.signer);
      const id = newSignerId();
      const next: MultisigSigner[] = [...signers, { ...action.signer, id }];
      assertSignerSetUnique(next);
      validateThreshold(threshold, next.length);
      return { signers: next, threshold };
    }
    case "remove-signer": {
      const idx = signers.findIndex((s) => s.id === action.signerId);
      if (idx < 0) throw new Error("remove-signer: unknown signerId");
      const next = signers.slice(0, idx).concat(signers.slice(idx + 1));
      if (next.length < threshold) {
        throw new Error(
          "remove-signer: would leave roster below current threshold; " +
            "lower threshold via change-threshold first",
        );
      }
      if (next.length < 1) {
        throw new Error("remove-signer: at least one signer is required");
      }
      return { signers: next, threshold };
    }
    case "replace-signer": {
      const idx = signers.findIndex((s) => s.id === action.signerId);
      if (idx < 0) throw new Error("replace-signer: unknown signerId");
      validateSignerInput(action.replacement);
      // Reuse the existing id so any in-flight proposals that
      // reference the signer (via proposedBy) continue to render
      // sensibly. This is the standard "rotate key" pattern; users
      // who want a clean separation can remove-then-add instead.
      const next = signers.slice();
      next[idx] = { ...action.replacement, id: signers[idx]!.id };
      assertSignerSetUnique(next);
      return { signers: next, threshold };
    }
    case "change-threshold": {
      validateThreshold(action.threshold, signers.length);
      return { signers, threshold: action.threshold };
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cross-signer coordination (Commit 7)
// ────────────────────────────────────────────────────────────────────────────

/** Schema-bound envelope wrapping a serialized proposal blob. The
 *  `kind` discriminator is what the importer keys on to route into
 *  the tx or governance queue. The `v` field is a future-proofing
 *  tag — bump it (and rotate the proposal hash domain in parallel)
 *  to invalidate stale exports cleanly. */
export interface SharedProposalEnvelope {
  v: 1;
  kind: "tx" | "gov";
  proposal: PendingProposal | GovernanceProposal;
}

/** Encode a proposal as a base64-encoded JSON envelope suitable for
 *  pasting into a chat / email / QR code. The output is wire-stable:
 *  re-encoding the same proposal yields the same bytes. Pure. */
export function serializeProposalForShare(
  proposal: PendingProposal | GovernanceProposal,
  kind: "tx" | "gov",
): string {
  const envelope: SharedProposalEnvelope = { v: 1, kind, proposal };
  const json = JSON.stringify(envelope);
  return bytesToBase64(new TextEncoder().encode(json));
}

/** Decode a shared-proposal blob back to an envelope. Throws on
 *  malformed base64, malformed JSON, missing version tag, or
 *  structural mismatch with the kind discriminator. Does NOT verify
 *  signatures — caller must run {@link verifyProposalApprovals} or
 *  the governance equivalent before trusting the contents. */
export function deserializeSharedProposal(
  blob: string,
): SharedProposalEnvelope {
  const trimmed = blob.trim();
  if (trimmed.length === 0) {
    throw new Error("empty shared-proposal blob");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(trimmed);
  } catch {
    throw new Error("shared-proposal blob is not valid base64");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("shared-proposal blob is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("shared-proposal envelope is not an object");
  }
  const env = parsed as Record<string, unknown>;
  if (env["v"] !== 1) {
    throw new Error(`unsupported shared-proposal version: ${env["v"]}`);
  }
  if (env["kind"] !== "tx" && env["kind"] !== "gov") {
    throw new Error(`unknown shared-proposal kind: ${env["kind"]}`);
  }
  if (!env["proposal"] || typeof env["proposal"] !== "object") {
    throw new Error("shared-proposal envelope missing proposal payload");
  }
  return env as unknown as SharedProposalEnvelope;
}

/** Verify every signature in a tx proposal's approvals + rejections
 *  against the corresponding signer's pubkey from the local roster.
 *  Returns the set of signerIds whose signatures verified. Throws
 *  if any signature is malformed or references an unknown signer
 *  (these are integrity errors the importer must surface, not
 *  silently drop). Signatures that fail verification are simply
 *  excluded from the returned set — the caller can compare to the
 *  raw approvals[] to detect tampering. */
export function verifyProposalApprovals(
  proposal: PendingProposal,
  signers: readonly MultisigSigner[],
): { validApprovals: Set<string>; validRejections: Set<string> } {
  const digest = hashTxProposal(proposal);
  const validApprovals = new Set<string>();
  const validRejections = new Set<string>();
  for (const a of proposal.approvals) {
    if (verifySignatureFor(a, signers, digest)) validApprovals.add(a.signerId);
  }
  for (const r of proposal.rejections) {
    if (verifySignatureFor(r, signers, digest)) validRejections.add(r.signerId);
  }
  return { validApprovals, validRejections };
}

/** Mirror of {@link verifyProposalApprovals} for governance proposals. */
export function verifyGovernanceApprovals(
  proposal: GovernanceProposal,
  signers: readonly MultisigSigner[],
): { validApprovals: Set<string>; validRejections: Set<string> } {
  const digest = hashGovernanceProposal(proposal);
  const validApprovals = new Set<string>();
  const validRejections = new Set<string>();
  for (const a of proposal.approvals) {
    if (verifySignatureFor(a, signers, digest)) validApprovals.add(a.signerId);
  }
  for (const r of proposal.rejections) {
    if (verifySignatureFor(r, signers, digest)) validRejections.add(r.signerId);
  }
  return { validApprovals, validRejections };
}

/** Merge incoming approvals + rejections into a local tx proposal.
 *  Dedupes by signerId (later signatures from the same signer are
 *  ignored — first-wins). Signatures that fail verification against
 *  the local roster are skipped. The returned proposal has the
 *  union of valid signatures.
 *
 *  Pre-conditions enforced:
 *    - local + incoming must share the same id + vaultAddress + action
 *    - if either is in a terminal status, the result is the local
 *      proposal unchanged (the off-band sender's view is stale).
 */
export function mergeProposalSignatures(
  local: PendingProposal,
  incoming: PendingProposal,
  signers: readonly MultisigSigner[],
): PendingProposal {
  if (local.id !== incoming.id) {
    throw new Error("merge: proposal id mismatch");
  }
  if (local.vaultAddress.toLowerCase() !== incoming.vaultAddress.toLowerCase()) {
    throw new Error("merge: vault address mismatch");
  }
  if (
    canonicalActionFingerprint(local.action) !==
    canonicalActionFingerprint(incoming.action)
  ) {
    throw new Error("merge: action mismatch");
  }
  if (local.status !== "pending") return local;
  const digest = hashTxProposal(local);
  const seenApprovals = new Set(local.approvals.map((a) => a.signerId));
  const seenRejections = new Set(local.rejections.map((r) => r.signerId));
  const out: PendingProposal = {
    ...local,
    approvals: [...local.approvals],
    rejections: [...local.rejections],
  };
  for (const a of incoming.approvals) {
    if (seenApprovals.has(a.signerId) || seenRejections.has(a.signerId)) continue;
    if (!verifySignatureFor(a, signers, digest)) continue;
    out.approvals.push(a);
    seenApprovals.add(a.signerId);
  }
  for (const r of incoming.rejections) {
    if (seenApprovals.has(r.signerId) || seenRejections.has(r.signerId)) continue;
    if (!verifySignatureFor(r, signers, digest)) continue;
    out.rejections.push(r);
    seenRejections.add(r.signerId);
  }
  return out;
}

/** Mirror of {@link mergeProposalSignatures} for governance proposals. */
export function mergeGovernanceSignatures(
  local: GovernanceProposal,
  incoming: GovernanceProposal,
  signers: readonly MultisigSigner[],
): GovernanceProposal {
  if (local.id !== incoming.id) {
    throw new Error("merge: proposal id mismatch");
  }
  if (local.vaultAddress.toLowerCase() !== incoming.vaultAddress.toLowerCase()) {
    throw new Error("merge: vault address mismatch");
  }
  if (
    canonicalGovActionFingerprint(local.action) !==
    canonicalGovActionFingerprint(incoming.action)
  ) {
    throw new Error("merge: governance action mismatch");
  }
  if (local.status !== "pending") return local;
  const digest = hashGovernanceProposal(local);
  const seenApprovals = new Set(local.approvals.map((a) => a.signerId));
  const seenRejections = new Set(local.rejections.map((r) => r.signerId));
  const out: GovernanceProposal = {
    ...local,
    approvals: [...local.approvals],
    rejections: [...local.rejections],
  };
  for (const a of incoming.approvals) {
    if (seenApprovals.has(a.signerId) || seenRejections.has(a.signerId)) continue;
    if (!verifySignatureFor(a, signers, digest)) continue;
    out.approvals.push(a);
    seenApprovals.add(a.signerId);
  }
  for (const r of incoming.rejections) {
    if (seenApprovals.has(r.signerId) || seenRejections.has(r.signerId)) continue;
    if (!verifySignatureFor(r, signers, digest)) continue;
    out.rejections.push(r);
    seenRejections.add(r.signerId);
  }
  return out;
}

function verifySignatureFor(
  sig: ProposalSignature,
  signers: readonly MultisigSigner[],
  digest: Uint8Array,
): boolean {
  const signer = signers.find((s) => s.id === sig.signerId);
  if (!signer) return false;
  let pubBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubBytes = hexToBytes(signer.pubkey, 1952);
    sigBytes = hexToBytes(sig.signature, 3309);
  } catch {
    return false;
  }
  try {
    return ml_dsa65.verify(sigBytes, digest, pubBytes);
  } catch {
    return false;
  }
}

function canonicalActionFingerprint(action: ProposalAction): string {
  return canonicalStringify(normalizeAction(action));
}

function canonicalGovActionFingerprint(action: GovernanceAction): string {
  return canonicalStringify(normalizeGovernanceAction(action));
}

// ────────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────────

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string, expectedLen: number): Uint8Array {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("hex string must be 0x + hex chars");
  }
  if (hex.length - 2 !== expectedLen * 2) {
    throw new Error(`hex string must encode ${expectedLen} bytes`);
  }
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return out;
}

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      entries
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalStringify(v))
        .join(",") +
      "}"
    );
  }
  throw new Error(`canonicalStringify: unsupported value type ${typeof value}`);
}

function normalizeAction(action: ProposalAction): Record<string, unknown> {
  if (action.kind === "send") {
    return {
      kind: "send",
      to: action.to.toLowerCase(),
      valueWeiHex: action.valueWeiHex.toLowerCase(),
      chainIdHex: action.chainIdHex.toLowerCase(),
      data: action.data?.toLowerCase(),
      gasLimitHex: action.gasLimitHex?.toLowerCase(),
    };
  }
  return {
    kind: "contract",
    to: action.to.toLowerCase(),
    data: action.data.toLowerCase(),
    chainIdHex: action.chainIdHex.toLowerCase(),
    valueWeiHex: action.valueWeiHex?.toLowerCase(),
    gasLimitHex: action.gasLimitHex?.toLowerCase(),
  };
}

function normalizeGovernanceAction(
  action: GovernanceAction,
): Record<string, unknown> {
  if (action.kind === "add-signer") {
    return {
      kind: "add-signer",
      signer: {
        label: action.signer.label,
        address: action.signer.address.toLowerCase(),
        pubkey: action.signer.pubkey.toLowerCase(),
        role: action.signer.role,
        vaultId: action.signer.vaultId,
      },
    };
  }
  if (action.kind === "remove-signer") {
    return { kind: "remove-signer", signerId: action.signerId };
  }
  if (action.kind === "replace-signer") {
    return {
      kind: "replace-signer",
      signerId: action.signerId,
      replacement: {
        label: action.replacement.label,
        address: action.replacement.address.toLowerCase(),
        pubkey: action.replacement.pubkey.toLowerCase(),
        role: action.replacement.role,
        vaultId: action.replacement.vaultId,
      },
    };
  }
  return { kind: "change-threshold", threshold: action.threshold };
}

// ────────────────────────────────────────────────────────────────────────────
// Test-only exports
// ────────────────────────────────────────────────────────────────────────────

export const __testing = {
  canonicalStringify,
  normalizeAction,
  normalizeGovernanceAction,
  TX_HASH_DOMAIN,
  GOV_HASH_DOMAIN,
};
