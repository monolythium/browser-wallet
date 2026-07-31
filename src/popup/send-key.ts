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

// ── Params builders for the surfaces that carry a key ───────────────────────
//
// One place for the `params` rule, so "does this surface include its editable
// field?" is a question a test can ask. The rule they all obey: the user's
// INTENT and nothing derived live. No quoted fee, no gas estimate, no pending
// reward amount — those move between attempts on their own, every retry would
// look like an edit, and the mechanism would never fire.
//
// Send and Stake build theirs inline; these are the shape-D surfaces converted
// afterwards.

/** Reward claim (Delegations, Stake). NO user-editable field exists — a claim
 *  has no recipient, amount or tier — so this is constant per chain and the
 *  comparison can never break a carry. Safety comes from the RELEASE instead:
 *  `success` clears the key, so the only reusable key belongs to a claim that
 *  failed, and a genuine later claim mints fresh. */
export function claimKeyParams(chainIdHex: string): string {
  return `claim|${chainIdHex}`;
}

/** Auto-compound toggle. `target` IS editable despite being a boolean: the user
 *  can abandon a failed ENABLE and confirm a DISABLE instead, and replaying the
 *  enable — which also claims pending rewards — while the modal says Disable is
 *  exactly the row-3 failure. */
export function autoCompoundKeyParams(target: boolean, chainIdHex: string): string {
  return `autocompound|${target}|${chainIdHex}`;
}

/** Emergency-backup key registration. `publicKeyHex` is the editable field: the
 *  key looks fixed, but clearing and regenerating the backup produces a new one
 *  under the same vault id, and replaying the old registration would anchor a
 *  key the user just replaced. */
export function emergencyKeyParams(
  vaultId: string,
  publicKeyHex: string,
  chainIdHex: string,
): string {
  return `emergency-key|${vaultId}|${publicKeyHex}|${chainIdHex}`;
}

// ── Name operations ─────────────────────────────────────────────────────────
//
// WHAT IS DELIBERATELY ABSENT: the quoted registration cost. `submitNameTx`
// re-quotes it from the LIVE base fee immediately before signing, so it can
// differ between two attempts at the same registration. In params it would make
// every retry look like an edit and the mechanism would never fire — the exact
// trap the module header warns about, and the one this surface was most likely
// to hit. The category and label length are absent for a different reason: they
// are derived deterministically from the name, so they carry nothing the name
// does not already.
//
// WHAT IS PRESENT is what the user would recognise as changing their request.
// Names are canonicalised to lower case by the chain-side validator, so a
// case-only difference is the SAME name and must not break a carry.

/** Register. The name is the whole request; a name is unique, so registering the
 *  same one twice is not a meaningful intention and an unchanged repeat is
 *  unambiguously a retry. */
export function nameRegisterKeyParams(canonical: string, chainIdHex: string): string {
  return `name-register|${canonical.toLowerCase()}|${chainIdHex}`;
}

/** Propose-transfer. The RESOLVED recipient is intent, not derivation: it is who
 *  receives the name, and the address is what gets signed. If the same `.mono`
 *  recipient re-resolves to a different owner between attempts, that is a
 *  changed request and the carry must break. Compared lower-case — hex address
 *  casing is display-only and must not read as an edit. */
export function nameProposeKeyParams(
  canonical: string,
  recipientAddr0x: string,
  chainIdHex: string,
): string {
  return `name-propose|${canonical.toLowerCase()}|${recipientAddr0x.toLowerCase()}|${chainIdHex}`;
}

/** Accept-transfer. Identified by the name alone — the payload carries nothing
 *  else, and the cost is re-quoted at signing like register's. */
export function nameAcceptKeyParams(canonical: string, chainIdHex: string): string {
  return `name-accept|${canonical.toLowerCase()}|${chainIdHex}`;
}

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
