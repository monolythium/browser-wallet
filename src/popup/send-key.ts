// Send-idempotency key scoping.
//
// One key identifies one LOGICAL send. A retry of that send reuses it, so the
// service worker re-broadcasts the bytes it already signed rather than deriving
// a fresh nonce and landing a second transaction. Everything else mints a new
// key so a genuine second send gets its own nonce.
//
// WHY THE ACTION AND NOT THE FORM. The submit ops are reached from surfaces with
// four different retry shapes: back-to-the-form, direct re-submit with no form
// at all, retry-that-wipes-the-form, and surfaces with no retry affordance
// whatsoever. Three of those have no usable form tuple, so a rule derived from
// `(recipient, amount, tier)` fits exactly one surface. The caller therefore
// tells this function what the user DID, and this function decides which key
// that implies.
//
// WHY PARAMS ARE STILL NEEDED. In the back-to-the-form shape the retry hands the
// user an editable form. If they change the recipient and confirm, carrying the
// key blindly would replay the ORIGINAL transaction while the interface shows
// the edited one — funds to someone the user just decided against, with the UI
// disagreeing. That is worse than the double-send this mechanism exists to
// prevent, because a double-send at least goes where the user chose. So a
// carried key is honoured only while the transaction it was minted against is
// unchanged.
//
// WHAT BELONGS IN `params`. The user's INTENT — recipient, amount, chosen fee
// tier — and nothing derived live. In particular do NOT include a quoted fee or
// a gas estimate: those move between attempts on their own, every retry would
// look like an edit, and the mechanism would never fire. `params` is opaque
// here; each surface builds its own and this module only compares.

export type SendKeyAction =
  /** The user is starting a send. Always a new logical send. */
  | "submit"
  /** The user is retrying the attempt that just failed. */
  | "retry"
  /** The flow was abandoned or the form was cleared — start over. */
  | "reset"
  /** The send landed. Release the key so the next one is independent. */
  | "success";

/** The key currently in flight, and the transaction it was minted against. */
export type SendKeyState = { key: string; params: string } | null;

export interface SendKeyDecision {
  /** The key this submit should carry, or null when the action is not a submit. */
  use: string | null;
  /** State to store for the next decision. */
  next: SendKeyState;
}

/**
 * Decide which idempotency key a submit should carry.
 *
 * `mint` is injected rather than called directly so tests are deterministic
 * without stubbing global crypto, and so a caller can supply whatever
 * uniqueness source it already has.
 */
export function nextSendKey(
  prev: SendKeyState,
  action: SendKeyAction,
  params: string,
  mint: () => string,
): SendKeyDecision {
  if (action === "success" || action === "reset") {
    // No key is being used, and nothing is carried forward. `success` is what
    // keeps a deliberate second identical send working; `reset` is how the
    // wipe-the-form shape says "this is a different send now".
    return { use: null, next: null };
  }

  if (action === "retry" && prev !== null && prev.params === params) {
    // The only path that carries. Exact match: anything that changes the
    // transaction the user is looking at must break the carry.
    return { use: prev.key, next: prev };
  }

  // Everything else is a new logical send: a first submit, a repeat press
  // (ambiguous, so never treated as a replay), a retry whose transaction was
  // edited, or a retry with no state to carry because the popup was reopened.
  const key = mint();
  return { use: key, next: { key, params } };
}
