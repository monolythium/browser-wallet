// Block-height parsing, shared by the popup's chain-health poll and the SW's
// WS `newHeads` writer.
//
// WHY THIS MODULE EXISTS. The liveness check used to compare block hexes as
// STRINGS, so any difference counted as progress — including a DECREASE. The
// public gateway load-balances per request across backends at different
// heights, so the reported head alternates, and a wallet that treats "changed"
// as "advanced" reports LIVE against a chain that has not moved. Comparing
// heights instead needs a parse, and the parse has to be total: the transport
// validates only `typeof result === "string"` (readChainBlock in
// service-worker.ts), so a malformed value really does reach the caller and a
// bare `BigInt()` would throw inside the poll tick.
//
// `isWellFormedBlockNumberHex` was previously defined in background/ws-client.ts
// and is re-exported from there for its existing callers. It lives here because
// ws-client carries WebSocket and chrome APIs, which the popup must not pull in.

/** True when `v` is a well-formed block-number hex: "0x" followed by 1..16 hex
 *  digits (a u64 block height is at most 16 digits). Rejects null, objects,
 *  empty "0x", non-hex and oversized strings — so a connected operator cannot
 *  push a malformed/garbage block number into banner state (F-2.4/#21). */
export function isWellFormedBlockNumberHex(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(v);
}

/** Parse a block-number hex to its height, or null when it isn't one.
 *
 *  Leading zeros are insignificant: "0x0003547a" and "0x3547a" are the SAME
 *  height, which the old string comparison would have called a change. Never
 *  throws — an unparsable reading is `null`, which callers treat as "no
 *  reading" rather than as a new head. */
export function parseBlockHeight(v: unknown): bigint | null {
  return isWellFormedBlockNumberHex(v) ? BigInt(v) : null;
}
