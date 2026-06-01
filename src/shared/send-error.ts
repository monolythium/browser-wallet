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
//   - "ferveo decryption ceremony failed; partial-share count 6 of 7"
//
// This module classifies the raw error into a typed kind so the popup
// can render context-aware copy + a specific recovery suggestion. The
// kind / copy pairs are intentionally written for users who are
// transacting, not debugging.
//
// Whitepaper alignment:
//   §21.5  — Ferveo encrypted mempool (failure mode = "encrypted-submit
//            failed; falling back to plaintext")
//   §22    — EIP-1559-style fee model (execution-unit estimation failures)
//   §23.2  — liquid bonding (no nonce/cooldown blockers for delegators
//            specifically — but nonce-too-low still happens on multi-
//            tab sends)

/** Discriminated error category. Defaults to "unknown" for messages
 *  the classifier doesn't recognise; the popup then renders the raw
 *  message verbatim (preserving the existing behaviour). */
export type SendErrorKind =
  | "insufficient-funds"
  | "gas-estimation"
  | "nonce-conflict"
  | "operator-offline"
  | "encryption-failure"
  | "user-rejected"
  | "transaction-reverted"
  | "spending-policy-blocked"
  | "wallet-locked"
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

/** Best-effort classification. Pattern-matches against the chain-side
 *  error message; ordered from most specific to most generic. */
export function classifySendError(
  message: string,
  context?: SendErrorContext,
): SendErrorClassification {
  const lower = message.toLowerCase();

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
        "The wallet could not estimate the execution units for this " +
        "transaction. The recipient contract may reject it. Check the " +
        "recipient address and amount, then try again.",
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
        "The current operator is not responding. Try switching network " +
        "in Settings → Network.",
      severity: "warn",
    };
  }

  // Encrypted-submit failures — Ferveo / ML-KEM body.
  if (
    lower.includes("encryption") ||
    lower.includes("ferveo") ||
    lower.includes("ml-kem") ||
    lower.includes("encrypted-submit") ||
    lower.includes("decryption")
  ) {
    return {
      kind: "encryption-failure",
      headline: "Encrypted submission failed",
      body:
        "The encrypted-mempool ceremony rejected this transaction. The " +
        "operator may be on an older binary or a key-rotation epoch may " +
        "be in flight. Try again in a few seconds.",
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

  // Generic EVM revert — recipient contract chose to abort.
  if (
    lower.includes("execution reverted") ||
    lower.includes("revert")
  ) {
    return {
      kind: "transaction-reverted",
      headline: "Recipient contract rejected the transaction",
      body:
        "The destination contract reverted execution. Check that the " +
        "function arguments are correct.",
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

  // Unrecognised — preserve the raw message in body.
  return {
    kind: "unknown",
    headline: "Transaction failed",
    body: message,
    severity: "err",
  };
}

const LYTHOSHI_PER_LYTH = 100_000_000n;
const LYTHOSHI_DECIMALS = 8;

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
    const fracStr = frac.toString().padStart(LYTHOSHI_DECIMALS, "0");
    return `${whole}.${fracStr}`;
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
