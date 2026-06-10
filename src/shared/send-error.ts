// Send-page error classifier.
//
// The Send.tsx error state previously stored a generic
// `{ message, code, method, via }` and rendered `message` verbatim.
// That's fine when the error message is human-readable
// ("insufficient funds for transfer"), but most chain-side error
// messages are debugger output, not user copy:
//   - "execution reverted (no data present; likely require(false))"
//   - "intrinsic gas too low; sender: 0xabcd; got: 21000"
//   - "nonce too low; have 14, want 15"
//   - "replacement transaction underpriced"
//
// This module classifies the raw error into a typed kind so the popup
// can render context-aware copy + a specific recovery suggestion. The
// kind / copy pairs are intentionally written for users who are
// transacting, not debugging.
//
// Whitepaper alignment:
//   §21.5  — LythiumSeal encrypted mempool: the wallet seals (scheme-3 ML-KEM)
//            when the operator cluster serves a seal roster, else falls back to
//            plaintext (which an encryption-required chain rejects — see the
//            plaintext-not-allowed branch). The earlier Ferveo threshold-decrypt
//            path was removed.
//   §22    — EIP-1559-style fee model (execution-unit estimation failures)
//   §23.2  — liquid bonding (no nonce/cooldown blockers for delegators
//            specifically — but nonce-too-low still happens on multi-
//            tab sends)

import {
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
} from "@monolythium/core-sdk";

/** Discriminated error category. Defaults to "unknown" for messages
 *  the classifier doesn't recognise; the popup then renders the raw
 *  message verbatim (preserving the existing behaviour). */
export type SendErrorKind =
  | "genesis-mismatch"
  | "chain-quarantined"
  | "plaintext-not-allowed"
  | "insufficient-funds"
  | "gas-estimation"
  | "nonce-conflict"
  | "operator-offline"
  | "user-rejected"
  | "transaction-reverted"
  | "spending-policy-blocked"
  | "spending-policy-unavailable"
  | "wallet-locked"
  | "transaction-rejected"
  | "unknown";

export interface SendErrorClassification {
  kind: SendErrorKind;
  /** User-facing headline. Short, no jargon. */
  headline: string;
  /** Long-form recovery suggestion. One or two sentences. */
  body: string;
  /** Severity drives the styling of the error block (err = red,
   *  warn = amber, info = blue). */
  severity: "err" | "warn" | "info";
}

/** Optional supplementary context the classifier can read for richer
 *  copy. All fields optional — only the message is required. */
export interface SendErrorContext {
  /** Wallet's current balance in native lythoshi, as a hex string. When supplied
   *  AND error is insufficient-funds, the body line shows the actual
   *  balance + the gap. */
  walletBalanceLythoshiHex?: string;
  /** Outgoing transaction value in native lythoshi, hex. Used for the same. */
  txValueLythoshiHex?: string;
  /** Estimated network fee in native lythoshi, hex. Used for the same. */
  estimatedNetworkFeeLythoshiHex?: string;
}

/** Best-effort classification of a chain-side send error into a typed kind +
 *  user copy.
 *
 *  Unwrap-inner-first: mono-core's live broadcaster flattens EVERY mempool
 *  admission failure into `RpcError::UpstreamUnavailable(format!("mempool:
 *  {e}"))` (mono-core providers.rs:6385), which reaches the wallet as code
 *  -32047 + "upstream unavailable: mempool: <inner>". The generic "upstream
 *  unavailable" substring would otherwise let the chain-quarantined branch
 *  steal whatever specific error the chain wrapped (insufficient-funds,
 *  nonce-too-low, …) and mis-render it as a warn-level operator outage. So we
 *  strip the wrapper and classify the INNER reason on the existing predicates;
 *  chain-quarantined then fires ONLY for a bare wrapper (a genuine operator
 *  outage with no mempool inner). This is immune to future mono-core admission
 *  errors — any new inner is classified on its merits, never stolen by the
 *  wrapper. (Supersedes the three prior "hoist above chain-quarantined" reorder
 *  patches — those predicates still match, now via the inner.) See
 *  _dev-notes/browser-wallet/2026-06-09_followup-dispose-classifier-residue-INSPECT.md
 *  Part 2A. */
export function classifySendError(
  message: string,
  context?: SendErrorContext,
): SendErrorClassification {
  const inner = extractMempoolInner(message);
  if (inner !== null) {
    return classifyInnerError(inner, context, true);
  }
  return classifyInnerError(message, context, false);
}

/** Strip an `upstream unavailable: mempool: ` wrapper and return the inner
 *  admission-error string, or null when the message is not a has-inner mempool
 *  wrapper (a bare "upstream unavailable" outage, or a non-wrapped error). The
 *  locate is case-insensitive; the inner is sliced from the ORIGINAL message so
 *  display casing is preserved. An empty/whitespace inner returns null (treated
 *  as a bare wrapper → chain-quarantined). */
function extractMempoolInner(message: string): string | null {
  const marker = "upstream unavailable: mempool: ";
  const idx = message.toLowerCase().indexOf(marker);
  if (idx === -1) return null;
  const inner = message.slice(idx + marker.length).trim();
  return inner.length > 0 ? inner : null;
}

/** Pattern-matches the (already-unwrapped) chain-side error message against the
 *  branch chain, ordered from most specific to most generic. `wrapped` is true
 *  when the caller stripped a mempool wrapper — it only changes the FINAL
 *  fallback (an unrecognized admission rejection is an honest transaction
 *  rejection, not "unknown" and not an operator outage). */
function classifyInnerError(
  message: string,
  context: SendErrorContext | undefined,
  wrapped: boolean,
): SendErrorClassification {
  const lower = message.toLowerCase();

  // Transient admission-time backend fault while the chain READS the spending
  // policy — mono-core SpendingPolicyStorageRead, Display
  // "spending-policy: admission-time storage read failed: <reason>". The user's
  // policy is fine; this is a rare I/O glitch, not a violation — classify it as
  // a retryable transient so we don't mis-advise "adjust your policy".
  //
  // CHECKED FIRST (above genesis-mismatch / plaintext-not-allowed / operator /
  // gas / nonce / the generic spending-policy block): the <reason> tail is
  // arbitrary mono-core text that may incidentally contain another branch's
  // trigger substring (a storage "timeout" → operator-offline, or a reason that
  // mentions "genesis" / "plaintext … not allowed"), which would otherwise
  // steal it. The predicate stays maximally SPECIFIC — "storage read failed"
  // AND a spending-policy context — so it never steals a genuine genesis /
  // plaintext / operator / gas / nonce error (none carry that signature), and a
  // real policy violation still reads as spending-policy-blocked (whose
  // predicate lacks "storage read failed"). Runs after the unwrap-inner-first
  // step in classifySendError, so the 2A chain-quarantined ordering is intact.
  if (
    lower.includes("storage read failed") &&
    (lower.includes("spending-policy") || lower.includes("spending policy"))
  ) {
    return {
      kind: "spending-policy-unavailable",
      headline: "Couldn't check your spending policy",
      body:
        "A temporary network issue interrupted the spending-policy check — " +
        "your policy is unchanged. Try again in a moment.",
      severity: "warn",
    };
  }

  // Chain genesis mismatch — the wallet's pinned genesis no longer matches
  // the network (likely a regenesis). The Send ErrorView renders this kind's
  // body with a clickable "Operators" link. Display/classification only — the
  // trust gate itself is unchanged (build-info.ts pin + networks.ts).
  if (
    lower.includes("untrusted genesis") ||
    lower.includes("genesis mismatch")
  ) {
    return {
      kind: "genesis-mismatch",
      headline: "Chain genesis mismatch",
      body:
        "The wallet's pinned chain genesis no longer matches the live " +
        "network, which may have re-genesised. Sends are paused until the " +
        "pinned genesis is updated. See Operators.",
      severity: "err",
    };
  }

  // Chain requires encrypted transactions and the wallet's encrypted (LythiumSeal)
  // submission wasn't used for this tx: the dispatcher seals when the operator
  // cluster serves a seal roster, but here the roster was unavailable, so it fell
  // back to plaintext, which the encrypted-mempool milestone rejects ("plaintext
  // mempool entry not allowed: encrypted envelope required"; code -32040
  // PlaintextNotAllowed, or -32047 on v0.1.44-testnet). Classify it so the user
  // sees an honest explanation instead of a raw debugger string. This branch only
  // explains the rejection; the encrypted path itself lives in submitMlDsaTx.
  //
  // MUST precede the chain-quarantined branch below: the chain wraps this as
  // "upstream unavailable: mempool: plaintext … not allowed …", so the generic
  // "upstream unavailable" match would otherwise intercept it and show the wrong
  // (operator-outage) message. The predicate stays SPECIFIC (the plaintext /
  // encrypted-envelope substring) so a genuine "upstream unavailable" outage
  // WITHOUT that substring still falls through to chain-quarantined — see the
  // send-error.test ordering regression guard.
  if (
    (lower.includes("plaintext") &&
      (lower.includes("not allowed") || lower.includes("encrypted envelope"))) ||
    lower.includes("encrypted mempool required")
  ) {
    return {
      kind: "plaintext-not-allowed",
      headline: "Encrypted transactions required",
      body:
        "This network requires encrypted transactions, but the encrypted " +
        "submission path was unavailable for this transaction, so the network " +
        "rejected it. Your funds are unaffected — nothing was transferred. " +
        "Try again in a moment.",
      severity: "err",
    };
  }

  // Execution-unit limit below the chain's intrinsic floor. The chain wraps it
  // as "upstream unavailable: mempool: tx execution-unit limit X below intrinsic
  // floor Y" (-32047), which the chain-quarantined branch below would otherwise
  // steal — so it MUST be checked first. Encrypted (sealed) submissions carry a
  // much higher floor (~250k); the wallet raises the limit automatically for
  // them, so a residual hit here is rare and means the raise was still short.
  if (
    lower.includes("below intrinsic floor") ||
    (lower.includes("execution-unit limit") && lower.includes("intrinsic"))
  ) {
    return {
      kind: "gas-estimation",
      headline: "Transaction limit too low",
      body:
        "The network rejected the transaction's execution-unit limit as below " +
        "its minimum for this transaction. Your funds are unaffected — it was " +
        "rejected before inclusion.",
      severity: "err",
    };
  }

  // Replacement / already-pending: the chain wraps "upstream unavailable:
  // mempool: replace underpriced" — a duplicate-nonce submission whose fee does
  // not outbid the tx already pending at that nonce. Encrypted (sealed) txs sit
  // in the mailbox longer before reveal, so a retry while the first is still
  // pending lands here. Checked above chain-quarantined, which would otherwise
  // steal the "upstream unavailable" wrapper.
  if (
    lower.includes("replace underpriced") ||
    lower.includes("replacement transaction underpriced") ||
    lower.includes("already known")
  ) {
    return {
      kind: "nonce-conflict",
      headline: "Transaction already pending",
      body:
        "A transaction at this nonce is already pending. Encrypted transactions " +
        "take longer to confirm — wait for it to complete, or resubmit with a " +
        "higher fee to replace it. Your funds are unaffected: this was rejected " +
        "before inclusion.",
      severity: "warn",
    };
  }

  // Operator node quarantined / PQ-checkpoint or state-root mismatch / upstream
  // unavailable. The operator's node has stopped serving RPC (a checkpoint
  // state-root divergence, or its upstream is down). The raw message is a
  // multi-line operator runbook — chain_id/height/block_hash, local vs
  // checkpoint state roots, signer pubkey prefixes, a `protocore quarantine
  // clear` command — useless and alarming to a normal user. Plain body +
  // "See Operators"; the raw detail is shown only in developer mode at the
  // render sites. (Checked AFTER plaintext-not-allowed above so a wrapped
  // encrypted-required rejection routes to the specific message.)
  if (
    lower.includes("quarantin") ||
    lower.includes("checkpointstaterootmismatch") ||
    lower.includes("state-root mismatch") ||
    lower.includes("state root mismatch") ||
    lower.includes("checkpoint state-root") ||
    lower.includes("upstream unavailable")
  ) {
    return {
      kind: "chain-quarantined",
      headline: "Operator node unavailable",
      body:
        "The selected operator's node is temporarily out of sync with the " +
        "network and isn't serving requests right now. The wallet skips it " +
        "automatically and uses other operators — your funds are unaffected. " +
        "See Operators.",
      severity: "warn",
    };
  }

  // Insufficient funds — most common, gets the richest copy.
  if (
    lower.includes("insufficient funds") ||
    lower.includes("insufficient balance") ||
    lower.includes("not enough balance")
  ) {
    return {
      kind: "insufficient-funds",
      headline: "Insufficient LYTH",
      body: insufficientFundsBody(context),
      severity: "err",
    };
  }

  // Execution-unit estimation failures (legacy eth_estimateGas errors).
  if (
    lower.includes("gas required exceeds") ||
    lower.includes("intrinsic gas too low") ||
    lower.includes("cannot estimate gas")
  ) {
    return {
      kind: "gas-estimation",
      headline: "Could not estimate network fee",
      body:
        "The wallet couldn't estimate the execution units for this " +
        "transaction — it may be rejected when executed. Re-check the " +
        "transaction details, then try again.",
      severity: "err",
    };
  }

  // Nonce conflict — multi-tab sends or stale nonce.
  if (
    lower.includes("nonce too low") ||
    lower.includes("nonce already used") ||
    lower.includes("invalid nonce")
  ) {
    return {
      kind: "nonce-conflict",
      headline: "Pending transaction detected",
      body:
        "Another transaction with the same nonce is already in the " +
        "mempool. Wait for it to confirm, or reset the nonce in advanced " +
        "settings.",
      severity: "warn",
    };
  }

  // Operator transport failures.
  if (
    lower.includes("unreachable") ||
    lower.includes("timeout") ||
    lower.includes("network error") ||
    lower.includes("rpc error")
  ) {
    return {
      kind: "operator-offline",
      headline: "Operator unreachable",
      body:
        "The current operator isn't responding. The wallet skips it and " +
        "uses other operators automatically — nothing for you to do. " +
        "See Operators.",
      severity: "warn",
    };
  }

  // User rejected — they cancelled the prompt themselves.
  if (
    lower.includes("user rejected") ||
    lower.includes("user denied") ||
    lower.includes("cancelled by user")
  ) {
    return {
      kind: "user-rejected",
      headline: "Transaction cancelled",
      body: "You cancelled the transaction before signing.",
      severity: "info",
    };
  }

  // Generic execution revert — the transaction aborted during execution (a
  // contract call, or a native module rejecting the operation). Reached by the
  // staking surface too (delegate/undelegate/redelegate/claim funnel through
  // the same classifier), so the copy stays tx-type-neutral.
  if (
    lower.includes("execution reverted") ||
    lower.includes("revert")
  ) {
    return {
      kind: "transaction-reverted",
      headline: "Transaction reverted",
      body:
        "The network reverted this transaction during execution. If it calls " +
        "a contract, re-check the call arguments; otherwise re-check the " +
        "transaction details and try again.",
      severity: "err",
    };
  }

  // Spending-policy block (§24.10).
  if (
    lower.includes("spending policy") ||
    lower.includes("spending-policy") ||
    lower.includes("policy denied") ||
    lower.includes("budget exceeded")
  ) {
    return {
      kind: "spending-policy-blocked",
      headline: "Spending policy denied",
      body:
        "This transaction exceeds your wallet's spending policy. " +
        "Adjust the policy in Settings → Security or sign with a " +
        "higher-tier credential.",
      severity: "warn",
    };
  }

  // Wallet locked mid-flow.
  if (
    lower.includes("wallet locked") ||
    lower.includes("wallet is locked") ||
    lower.includes("not unlocked")
  ) {
    return {
      kind: "wallet-locked",
      headline: "Wallet locked",
      body:
        "The wallet auto-locked while preparing this transaction. " +
        "Unlock it and try again.",
      severity: "warn",
    };
  }

  // Unrecognised. When the caller stripped a mempool wrapper (`wrapped`), the
  // chain explicitly rejected the tx at admission — surface that honestly as a
  // transaction rejection (NOT an operator outage; before the unwrap the
  // "upstream unavailable" wrapper made these read as chain-quarantined). A
  // non-wrapped unknown keeps the prior raw-message behaviour.
  if (wrapped) {
    return {
      kind: "transaction-rejected",
      headline: "Transaction rejected",
      body:
        `The network rejected this transaction: ${message}. Your funds are ` +
        "unaffected — it was rejected before inclusion.",
      severity: "err",
    };
  }
  return {
    kind: "unknown",
    headline: "Transaction failed",
    body: message,
    severity: "err",
  };
}

/** Operator / node-health kinds whose body ends in "See Operators" — the
 *  render sites linkify that word to a button into the operator directory and
 *  (for these kinds) tuck the raw chain detail behind developer mode. */
export function errorLinksOperators(kind: SendErrorKind): boolean {
  return (
    kind === "genesis-mismatch" ||
    kind === "chain-quarantined" ||
    kind === "operator-offline"
  );
}

/** Colour palette per `SendErrorClassification.severity`, shared by the Send +
 *  Stake error surfaces so they stay consistent. `warn` (e.g. the transient
 *  spending-policy-unavailable) renders amber rather than the error-red of
 *  `err`, so a retryable condition doesn't read as a hard failure; `info` is
 *  neutral (e.g. a user-cancelled prompt). */
export function severityColours(severity: "err" | "warn" | "info"): {
  fg: string;
  iconBg: string;
  cardBg: string;
  borderRgba: string;
} {
  switch (severity) {
    case "err":
      return {
        fg: "var(--err)",
        iconBg: "rgba(220,80,80,0.12)",
        cardBg: "rgba(220,80,80,0.08)",
        borderRgba: "rgba(220,80,80,0.4)",
      };
    case "warn":
      return {
        fg: "var(--warn)",
        iconBg: "rgba(220,180,80,0.12)",
        cardBg: "rgba(220,180,80,0.08)",
        borderRgba: "rgba(220,180,80,0.4)",
      };
    case "info":
      return {
        fg: "var(--fg-200)",
        iconBg: "rgba(120,160,220,0.10)",
        cardBg: "rgba(120,160,220,0.06)",
        borderRgba: "rgba(120,160,220,0.3)",
      };
  }
}

// Native LYTH precision sourced from the SDK (single source of truth). Chain
// migrated 8 → 18 decimals (1 lythoshi == 1 wei); SDK 0.3.15 carries
// `LYTHOSHI_PER_LYTH = 10^18` and `NATIVE_LYTH_DECIMALS = 18`.
const LYTHOSHI_DECIMALS = NATIVE_LYTH_DECIMALS;

/** Format the insufficient-funds body. Adds an amount breakdown when
 *  the context supplies balance + value + network fee. */
function insufficientFundsBody(context?: SendErrorContext): string {
  if (!context) {
    return "Your wallet doesn't have enough LYTH to cover the amount plus the network fee.";
  }
  const balance = parseHexOrNull(context.walletBalanceLythoshiHex);
  const value = parseHexOrNull(context.txValueLythoshiHex);
  const networkFee = parseHexOrNull(context.estimatedNetworkFeeLythoshiHex);
  if (balance === null || value === null) {
    return "Your wallet doesn't have enough LYTH to cover the amount plus the network fee.";
  }
  const need = value + (networkFee ?? 0n);
  const shortfall = need > balance ? need - balance : 0n;
  const fmt = (lythoshi: bigint) => {
    const whole = lythoshi / LYTHOSHI_PER_LYTH;
    const frac = lythoshi % LYTHOSHI_PER_LYTH;
    // Pad to full precision then trim trailing zeros so an 18-decimal
    // domain doesn't render "1.000000000000000000".
    const fracStr = frac.toString().padStart(LYTHOSHI_DECIMALS, "0").replace(/0+$/, "");
    return fracStr.length === 0 ? whole.toString() : `${whole}.${fracStr}`;
  };
  let body =
    `You have ${fmt(balance)} LYTH but this transaction needs ${fmt(need)} LYTH`;
  if (networkFee !== null) {
    body += ` (${fmt(value)} amount + ${fmt(networkFee)} network fee)`;
  }
  body += `. Shortfall: ${fmt(shortfall)} LYTH.`;
  return body;
}

function parseHexOrNull(hex: string | undefined): bigint | null {
  if (hex === undefined) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}
