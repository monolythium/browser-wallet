// The transaction a send binding was minted for — its INTENT, canonicalised.
//
// WHY THIS EXISTS. `withSendBinding` used to resolve a binding by idempotency
// key alone: given a live key it re-broadcast the stored bytes without ever
// looking at the transaction it had been asked to submit. The §0 hand test
// walked straight through that — a send to A failed, the user pressed "Try
// again", changed the recipient to B, confirmed, and the wallet re-broadcast the
// bytes paying A while the screen said B. The recipient was read out of the
// stored `wireHex` itself.
//
// The popup already guards this: `src/popup/send-key.ts` mints a fresh key when
// the transaction changes, on every surface, and its suite pins the
// recipient-change case. That guard shipped, it is green, and the replay still
// happened. So this exists to make the property enforceable at the one place
// that can enforce it — the binding layer — rather than trusted to a convention
// repeated at eleven call sites.
//
// NO IMPORTS, DELIBERATELY. `send-binding.ts` imports nothing and takes its
// transport as injected callbacks, which is why its suite needs no signer, no
// SDK and no network. The binding layer only ever COMPARES two of these strings,
// so it does not import this module either — the caller computes the digest and
// hands it in. Keep both properties: a digest that needed a hash library would
// pull a dependency into the one module whose importlessness is load-bearing.
//
// WHAT IS IN IT, and what is deliberately not:
//
//   IN — `from`, `to`, `value`, `data`, `chainId`. The user's intent: who is
//   paying, who is being paid, how much, what is being called, on which chain.
//   A change to any of these is a different transaction by any reading.
//
//   OUT — `nonce`. Derived inside the submit path, never chosen by the user. A
//   differing nonce means the tracker moved on, which is exactly the case the
//   replay exists to serve; including it would break the carry on the one
//   scenario the mechanism is for.
//
//   OUT — `maxFeePerGas`, `maxPriorityFeePerGas`, `gas`. This is the load-
//   bearing exclusion and it was measured, not assumed. Send fetches its fee
//   suggestion in an effect keyed on the chain ("when the screen opens or the
//   chain changes"), so within one retry loop it does not move. But
//   `multisig-execute` calls `suggestFee` at execute time and the name ops
//   re-quote the registration cost from the live base fee immediately before
//   signing. Include the fee and every retry on those surfaces reads as an edit,
//   the binding never fires, and the double-send it prevents comes back. The
//   cost of excluding it is that a replay can carry a fee the user is no longer
//   being shown — a DISPLAY mismatch, never a fund-direction one, since the
//   recipient and amount are pinned here. It is also the behaviour that already
//   shipped, not something this change introduces.
//
//   OUT — `extensions`. The native-multisig path binds under the `monom`
//   address, is developer-gated with no users today, and is already refused at
//   the 0x40 front-door guard in `submitMlDsaTxWithHooks`. Revisit when that
//   path has users.
//
// A CANONICAL STRING, NOT A HASH. It is strictly smaller than the `wireHex` the
// same record already holds, so nothing is saved by hashing, and a plain string
// is auditable by eye and cannot collide. If this ever needs to shrink, hash it
// — but do it in this module, so `send-binding.ts` stays importless.

/** Lower-cased, or the empty string when absent. Hex casing is display-only —
 *  `0xAB` and `0xab` are the same address and must not read as an edit, the same
 *  rule `send-key.ts` applies to its own params. */
function norm(v: string | undefined): string {
  return v === undefined ? "" : v.toLowerCase();
}

/** The fields that identify one send's intent. Named rather than positional so
 *  a future field cannot be added at the wrong index. */
export interface SendIntent {
  from: string;
  to?: string | undefined;
  value?: string | undefined;
  data?: string | undefined;
  chainIdHex: string;
}

/**
 * The canonical digest of one send's intent.
 *
 * `|` separates fields and cannot appear in a hex quantity or an address, so no
 * two distinct intents can render to the same string by running together.
 */
export function sendIntentDigest(intent: SendIntent): string {
  return [
    "v1",
    norm(intent.from),
    norm(intent.to),
    norm(intent.value),
    norm(intent.data),
    norm(intent.chainIdHex),
  ].join("|");
}
