// Indexer-OFF activity fallback (#B3-2). When the per-address activity index is
// disabled (or genuinely empty) the wallet falls back to `lyth_txFeed` — a
// GLOBAL, block-scan-backed transaction feed that indexer-OFF operators still
// serve (mono-core `tx_feed_block_scan`) — and FILTERS it to this address so the
// user's recent activity still shows instead of a blank timeline.
//
// The fallback is deliberately conservative: it maps ONLY native LYTH value
// transfers (the shape that cleanly maps onto tx_send / tx_receive). A contract
// call (delegate / claim / token transfer) needs calldata decoding the fallback
// does NOT do, so it is dropped rather than mislabelled — an honest partial view,
// never fabricated activity (no-mock). When the indexer recovers, the richer
// address-activity stream supersedes this entirely.

import { bech32mToAddress } from "./bech32m.js";
import { lythoshiDecimalToLythDecimal } from "./lyth-units.js";
import type { ConfirmedRow } from "./activity.js";
import type { WalletActivityKind } from "./activity-kind.js";

/** The `u32::MAX` log-index sentinel native transfers carry in the indexer
 *  stream. A txFeed row has no log index, so a native-transfer fallback row
 *  adopts the same sentinel for a consistent anchor + dedup key. */
const NATIVE_TRANSFER_LOG_INDEX = 0xffffffff;

/** Subset of a `lyth_txFeed` `TxFeedTransaction` the wallet consumes for the
 *  indexer-off fallback. `value` is decimal lythoshi; `input` is 0x-hex calldata
 *  ("0x"/"" for a plain native transfer). */
export interface RawTxFeedTx {
  blockNumber: number;
  txIndex: number;
  from: string;
  to: string | null;
  value: string;
  input: string;
}

/** Tolerant address canonicaliser for the self-match + counterparty identity: a
 *  0x address lowercases; a bech32m `mono1…` decodes to its 0x form; anything
 *  else lowercases as-is. Never throws — the fallback must degrade, not crash, on
 *  an unexpected address shape. Normalises BOTH the queried address and the feed
 *  `from`/`to`, so the match works whether the operator echoes 0x or bech32m. */
function canonAddr(a: string): string {
  if (a.startsWith("0x") || a.startsWith("0X")) return a.toLowerCase();
  try {
    return bech32mToAddress(a, null).toLowerCase();
  } catch {
    return a.toLowerCase();
  }
}

/** True when a tx moved native LYTH with no calldata — the only txFeed shape
 *  that maps cleanly onto a tx_send / tx_receive row. A contract call (non-empty
 *  input) or a zero-value tx is skipped. */
function isNativeValueTransfer(tx: RawTxFeedTx): boolean {
  if (tx.input.replace(/^0x/i, "").length !== 0) return false;
  try {
    return BigInt(tx.value) > 0n;
  } catch {
    return false;
  }
}

/** Map a `lyth_txFeed` (GLOBAL) page to THIS wallet's confirmed activity rows —
 *  the indexer-OFF fallback (#B3-2). Keeps ONLY native value transfers that
 *  involve `userAddr` (as sender OR recipient), mapped to tx_send / tx_receive
 *  consistently with the address-activity stream (counterparty in canonical 0x
 *  form). A self-send resolves to a single send leg. Every other tx — not the
 *  user's, zero-value, or a contract call — is dropped: never fabricated, never
 *  mislabelled. Pure + newest-first-agnostic (the render layer sorts). */
export function mapTxFeedToRows(
  txs: readonly RawTxFeedTx[],
  userAddr: string,
): ConfirmedRow[] {
  const me = canonAddr(userAddr);
  const out: ConfirmedRow[] = [];
  for (const tx of txs) {
    if (!isNativeValueTransfer(tx)) continue;
    const from = canonAddr(tx.from);
    const to = tx.to === null ? null : canonAddr(tx.to);
    const fromMe = from === me;
    const toMe = to !== null && to === me;
    if (!fromMe && !toMe) continue;
    const amountDecimal = lythoshiDecimalToLythDecimal(tx.value);
    if (fromMe) {
      out.push({
        kind: "tx_send",
        blockHeight: tx.blockNumber,
        txIndex: tx.txIndex,
        logIndex: NATIVE_TRANSFER_LOG_INDEX,
        counterparty: to,
        amountDecimal,
      });
    } else {
      out.push({
        kind: "tx_receive",
        blockHeight: tx.blockNumber,
        txIndex: tx.txIndex,
        logIndex: NATIVE_TRANSFER_LOG_INDEX,
        counterparty: from,
        amountDecimal,
      });
    }
  }
  return out;
}

/** Whether the popup should consult the `lyth_txFeed` fallback for the CURRENT
 *  empty timeline (#B3-2). Fires ONLY when the confirmed timeline is empty for a
 *  BENIGN reason — the indexer is disabled, or the envelope is genuinely empty
 *  (`not_found`, incl. the default when an operator lacks the kind probe). It is
 *  NEVER enabled:
 *   - while the chain is non-live (`hideConfirmed`) — confirmed history is hidden;
 *   - when there is any confirmed / failed row to show already;
 *   - on a transient / operator ERROR (`hasIndexerError`) — that still surfaces
 *     + failovers per Phase 1, and must NOT be masked by a txFeed fallback;
 *   - for `pruned` / `private` / `unknown` kinds — those keep their own specific,
 *     semantically-correct empty states. */
export function txFeedFallbackEnabled(args: {
  hideConfirmed: boolean;
  confirmedCount: number;
  failedCount: number;
  hasIndexerError: boolean;
  kind: WalletActivityKind | null;
}): boolean {
  if (args.hideConfirmed) return false;
  if (args.confirmedCount > 0 || args.failedCount > 0) return false;
  if (args.hasIndexerError) return false;
  return args.kind === "indexer_disabled" || args.kind === "not_found";
}
