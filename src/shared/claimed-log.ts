// Decode the reward-claim amount from a tx receipt's `Claimed` event log.
//
// The delegation precompile (0x…100A) emits
//   Claimed(address indexed wallet, uint256 amount, bool autoCompound)
// topic0 = keccak256("Claimed(address,uint256,bool)"); data word-0 (bytes
// 0..31, big-endian) is the claimed amount in lythoshi, word-1 is autoCompound.
//
// This is the AUTHORITATIVE claimed amount — the chain records it AT EXECUTION,
// unlike the submit-time `lyth_pendingRewards.settledPendingLythoshi` snapshot
// (settled-only, pre-execution) which under-counts and reads 0 right after a
// prior claim (see 2026-06-20_claim-amount-wrong-inspect.md). A successful
// claim always emits exactly this log; the revert path (NoClaimableRewards)
// emits none — so a confirmed claim with no Claimed log is impossible (this
// returns null defensively, never a fabricated 0).
//
// Operator receipts (eth_getTransactionReceipt) carry `data` as a BYTE ARRAY
// (number[]) and `topics` as hex strings; the eth-standard hex-string `data`
// shape (e.g. lyth_decodeTx) is also accepted so the decode is robust across
// sources. NO-MOCK: returns null (never 0, never a guess) when no matching log
// is present, the bytes don't parse, or the amount exceeds MAX_PLAUSIBLE.

import { LYTHOSHI_PER_LYTH } from "@monolythium/core-sdk";

/** keccak256("Claimed(address,uint256,bool)") — the delegation-precompile
 *  reward-claim event topic. */
export const CLAIMED_EVENT_TOPIC0 =
  "0xfa8256f7c08bb01a03ea96f8b3a904a4450311c9725d1c52cdbe21ed3dc42dcc";

/** P5-004 — upper bound on a plausibly-real claimed reward, in lythoshi. The
 *  `Claimed` log is semi-trusted operator-echoed data; a rogue/buggy operator
 *  could return an absurd uint256 amount that the wallet would otherwise
 *  display/notify verbatim. A reward can never exceed the total LYTH supply
 *  (genesis 100M LYTH = 1e26 lythoshi); this caps at 2x that (200M LYTH),
 *  matching the wallet's existing MAX_PLAUSIBLE_BALANCE_LYTHOSHI anchor
 *  (tx-mldsa.ts). An amount over this is treated as UNDECODABLE — the decode
 *  returns null, so the UI shows the bare "Rewards claimed" with NO number (the
 *  same no-amount path), never a fabricated or clamped figure (no-mock). */
export const MAX_PLAUSIBLE_CLAIM_LYTHOSHI = 200_000_000n * LYTHOSHI_PER_LYTH;

/** The delegation system precompile address that emits `Claimed` (0x…100A). */
const DELEGATION_PRECOMPILE_LOG_ADDR =
  "0x000000000000000000000000000000000000100a";

interface ReceiptLogLike {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
}

/** First 32 bytes (big-endian uint256) of the log `data` as a decimal lythoshi
 *  string, or null. Accepts `data` as a byte array (number[], the operator
 *  receipt shape) or a 0x-hex string (the eth-standard / lyth_decodeTx shape). */
function readWord0Lythoshi(data: unknown): string | null {
  let bytes: number[] | null = null;
  if (Array.isArray(data)) {
    bytes = data as number[];
  } else if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data)) {
    const hex = data.slice(2);
    if (hex.length % 2 !== 0) return null;
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      out.push(Number.parseInt(hex.slice(i, i + 2), 16));
    }
    bytes = out;
  }
  if (bytes === null || bytes.length < 32) return null;
  let v = 0n;
  for (let i = 0; i < 32; i++) {
    const b = bytes[i]!;
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    v = (v << 8n) | BigInt(b);
  }
  // P5-004: an amount above the plausible cap is rogue/buggy operator echo, not
  // a real reward → treat as undecodable (null), never a wrong huge number.
  if (v > MAX_PLAUSIBLE_CLAIM_LYTHOSHI) return null;
  return v.toString(10);
}

/** Find the delegation-precompile `Claimed` log in a receipt's `logs` array and
 *  return its claimed amount as a decimal lythoshi string, or null when absent
 *  (no logs / no matching log / unparseable bytes). Pure; no RPC. */
export function decodeClaimedAmountLythoshi(logs: unknown): string | null {
  if (!Array.isArray(logs)) return null;
  for (const raw of logs) {
    if (!raw || typeof raw !== "object") continue;
    const log = raw as ReceiptLogLike;
    const addr =
      typeof log.address === "string" ? log.address.toLowerCase() : null;
    if (addr !== DELEGATION_PRECOMPILE_LOG_ADDR) continue;
    const topics = Array.isArray(log.topics) ? log.topics : null;
    const topic0 =
      topics && typeof topics[0] === "string" ? topics[0].toLowerCase() : null;
    if (topic0 !== CLAIMED_EVENT_TOPIC0) continue;
    return readWord0Lythoshi(log.data);
  }
  return null;
}
