// What to SHOW the user when a popup submit fails.
//
// A submit can fail two ways, and they are not the same fact:
//
//   1. The op REPLIED `{ ok: false, reason }`. The service worker ran, reached a
//      verdict, and told us. `reason` is already human copy written for this op
//      ("That name is already registered.") — it is rendered VERBATIM. Passing it
//      through classifySendError would replace good specific copy with the
//      generic "Transaction failed" fallback, so we don't.
//
//   2. The call THREW. Nothing replied. This is the case that was rendering
//      nothing at all on several surfaces, and it needs classifying because the
//      raw message is Chrome/chain internals, not user copy.
//
// Within (2) there is a distinction that MATTERS MORE THAN THE COPY:
//
//   - A CHAIN/network error reached us through a working service worker. The
//     shared classifier already separates "couldn't reach any operator, nothing
//     was sent" (operator-offline) from "the chain refused it" (transaction-
//     rejected), and its copy states the funds posture for each.
//
//   - The popup↔SW MESSAGE CHANNEL dropped (MV3 idle/teardown). Here the wallet
//     genuinely CANNOT KNOW whether the transaction was broadcast: the worker may
//     have signed, broadcast, and died before replying. This is NOT
//     operator-offline — that kind's copy promises "nothing was sent", which
//     would be a false reassurance in exactly the case where a retry can spend
//     twice. It gets its own kind and says plainly that the outcome is unknown.
//
// The classifier is not consulted for the SW-transport case at all, because none
// of its predicates match Chrome's wording ("Could not establish connection",
// "message port closed") — they would fall through to the "unknown" branch and
// render Chrome's internal string as if it were an explanation.

import { isSwIdleError } from "./bg";
import { classifySendError, type SendErrorKind } from "../shared/send-error";

/** `"verbatim"` = text that is ALREADY user copy (an `{ ok: false }` reason, or a
 *  client-side validation message) and is rendered unchanged.
 *  `"sw-transport-indeterminate"` = the popup↔SW channel dropped; submitted-or-not
 *  is UNKNOWN. Anything else is a `SendErrorKind` from the shared classifier. */
export type SubmitFailureKind =
  | "verbatim"
  | "sw-transport-indeterminate"
  | SendErrorKind;

export interface SubmitFailure {
  kind: SubmitFailureKind;
  /** Bold first line, or `null` to render `body` alone — which is what the
   *  `{ ok: false }` path does, preserving today's verbatim rendering exactly. */
  headline: string | null;
  body: string;
}

/** Text that is already user copy — an `{ ok: false, reason }` from the service
 *  worker, or a client-side validation message. Rendered unchanged, so every
 *  existing message on these surfaces reads exactly as it did before. `fallback`
 *  covers a reply that carried no reason string. */
export function verbatimFailure(
  text: string | null | undefined,
  fallback: string,
): SubmitFailure {
  const body = typeof text === "string" && text.trim().length > 0 ? text : fallback;
  return { kind: "verbatim", headline: null, body };
}

/** A THROWN submit. Separates the MV3 channel drop (outcome unknowable) from
 *  everything else (delegated to the shared Send/Stake classifier). */
export function submitThrowFailure(thrown: unknown): SubmitFailure {
  const message =
    thrown instanceof Error
      ? thrown.message
      : typeof thrown === "string"
        ? thrown
        : "";

  if (isSwIdleError(message)) {
    return {
      kind: "sw-transport-indeterminate",
      headline: "Couldn't confirm the submission",
      body:
        "The wallet lost contact with its background service while submitting, " +
        "so it can't tell whether this was sent. Check your recent activity " +
        "before trying again — a retry may submit it a second time.",
    };
  }

  const classified = classifySendError(message);
  return {
    kind: classified.kind,
    headline: classified.headline,
    body: classified.body,
  };
}
