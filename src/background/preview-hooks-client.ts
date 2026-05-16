// Phase 11.5 Commit 2 — chain reader for `lyth_previewTransactionHooks`
// (MS-CORE-0009 / mono-core @13fb4ceb).
//
// The chain handler at protocore.rs:576 takes a CallRequest (the same
// shape eth_call uses: from?, to, value?, data?, gas?, ...) and returns
// a TransactionHookPreview that lists which hooks the runtime would
// fire against this tx before it is included in a block. Today the
// payload is dominated by the spending-policy hook (§15) but the
// schema is open-ended via `warnings[]` and an evolving status field.
//
// The wallet pre-RPC-calls this on the Send preview screen so the user
// sees a "Hooks that will run" section before signing. The popup hides
// the section when the call returns `mock-not-deployed` (operator on
// an older chain build) so there is no UI regression for older
// operators that haven't shipped dd05511 yet.

import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  isTransactionHookPreview,
  type TransactionHookPreview,
} from "../shared/audit-followup-types.js";
import { sprintnetJsonRpc } from "./tx-mldsa.js";

/** Subset of the wallet's known tx fields that the chain needs to
 *  evaluate the spending-policy + fee-schedule hooks. `from` is
 *  optional on the chain side but the wallet always supplies it
 *  (the active account address) so policy evaluation has the same
 *  context as submit-time. */
export interface PreviewHooksInput {
  /** Hex 0x address — sender. Omitted only by callers that don't
   *  yet know the from address (e.g. a raw eth_call preview). */
  from?: string;
  /** Hex 0x address — recipient. Required. */
  to: string;
  /** Hex-encoded wei value. Omitted treats the tx as a zero-value
   *  call (the chain default). */
  valueWeiHex?: string;
  /** Hex-encoded calldata. Omitted for native LYTH transfers. */
  data?: string;
}

/** Placeholder used while the chain answer is in flight or when
 *  fallback hides the section. The popup never renders this directly
 *  in either path — `mock-not-deployed` hides the whole section, and
 *  `live` returns the real preview. The mock exists to satisfy
 *  `withChainFallback`'s typed `mockValue` requirement. */
const MOCK_PREVIEW: TransactionHookPreview = {
  schemaVersion: 1,
  wouldReject: false,
  warnings: [],
  spendingPolicy: {
    status: "unknown",
    details: {},
  },
};

/** Public exported alias so tests + callers can assert the same
 *  placeholder is in use without re-deriving the shape. */
export const PREVIEW_HOOKS_PLACEHOLDER: Readonly<TransactionHookPreview> = MOCK_PREVIEW;

/** Build the CallRequest object the chain expects from the wallet's
 *  PreviewHooksInput. Kept exported so the test suite can assert the
 *  exact JSON-RPC params we send. */
export function buildCallRequest(input: PreviewHooksInput): Record<string, string> {
  const cr: Record<string, string> = { to: input.to };
  if (input.from) cr.from = input.from;
  if (input.valueWeiHex) cr.value = input.valueWeiHex;
  if (input.data) cr.data = input.data;
  return cr;
}

/** Call `lyth_previewTransactionHooks` against the active operators,
 *  with typed shape validation + graceful fallback for operators that
 *  haven't deployed mono-core @dd05511 yet.
 *
 *  Outcomes:
 *   - `live`              — real preview from chain, render the section.
 *   - `mock-not-deployed` — operator returned -32601 (method missing);
 *                           popup hides the section entirely.
 *   - `mock-offline`      — transport-level failure; popup hides.
 *   - `mock-error`        — chain responded but the shape didn't match
 *                           the validator; popup hides + dev-tools log. */
export async function previewTransactionHooks(
  input: PreviewHooksInput,
): Promise<ChainOutcome<TransactionHookPreview>> {
  const callRequest = buildCallRequest(input);
  return withChainFallback<TransactionHookPreview>(
    async () => {
      const { result } = await sprintnetJsonRpc<TransactionHookPreview>(
        "lyth_previewTransactionHooks",
        [callRequest],
      );
      return result;
    },
    {
      mockValue: MOCK_PREVIEW,
      notLiveAs: "not-deployed",
      label: "lyth_previewTransactionHooks",
      timeoutMs: 5000,
      isValid: isTransactionHookPreview,
    },
  );
}
