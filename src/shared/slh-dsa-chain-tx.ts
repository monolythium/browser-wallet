// Phase 10 Commit 4 — calldata encoder + tx-shape builder for the
// emergency-key-registry precompile (`0x1100`).
//
// What this module owns
// =====================
// Pure ABI encoding for the chain-side `register(uint16,bytes)`
// selector and a helper that builds the {to, data, value} shape
// `bgWalletSendTx` expects. No `chrome.storage`, no IPC, no
// network — exclusively the encoding seam between the wallet's
// JS / TS surface and the precompile's Solidity-compatible ABI.
//
// Sourced from `mono-core/crates/precompiles/system/emergency-key-registry/`:
//
//   `register(uint16 algo, bytes pubkey)`
//     selector = keccak256("register(uint16,bytes)")[0..4]
//     head:
//       word 0 — uint16 algo, right-aligned (high 30 bytes zero)
//       word 1 — head-offset of the bytes body = 0x40 (one head word
//                after the algo word; the bytes body starts at byte
//                offset 64 of the args slice — `0x40`)
//     body (at offset 0x40):
//       word 0 — bytes length (32 for SLH-DSA-SHA2-128s pubkey)
//       word 1 — pubkey bytes, zero-padded to a 32-byte boundary
//                (already on the boundary for a 32-byte pubkey, so
//                no padding bytes follow)
//
// Reverts to be aware of (forwarded verbatim by `bgWalletSendTx`):
//   - `AlreadyRegistered` — second registration on the same address
//   - `WrongPubkeyLength` — pubkey not exactly 32 bytes (for algo=1101)
//   - `AlgoSameFamily(1001)` etc. — caller passed a lattice algo
//   - `UnsupportedAlgo` — caller passed a classical algo
//   - `ZeroAddress` / `StaticContext` — defensive ctx checks
//
// The wallet always passes `algo=1101` + a 32-byte SLH-DSA-SHA2-128s
// pubkey, so the only revert the user can realistically hit in
// practice is `AlreadyRegistered` (one-time per address).

import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  EMERGENCY_KEY_PRECOMPILE_ADDRESS,
  SLH_DSA_SHA2_128S_ALGO_ID,
  SLH_DSA_SHA2_128S_LENGTHS,
} from "./slh-dsa-backup.js";

/** Solidity signature of the register method, used to derive the
 *  4-byte selector. */
export const EMERGENCY_KEY_REGISTER_SIGNATURE = "register(uint16,bytes)";

// ────────────────────────────────────────────────────────────────────────────
// Selector — computed once on module load (deterministic; we don't
// hardcode because the test seam pins the value separately).
// ────────────────────────────────────────────────────────────────────────────

let _registerSelectorHex: string | null = null;

/** 0x-prefixed 4-byte selector for `register(uint16,bytes)`. Lazily
 *  computed via `keccak_256` so the module's startup cost is paid
 *  only when a registration is actually attempted. */
export function registerSelectorHex(): string {
  if (_registerSelectorHex === null) {
    const sig = new TextEncoder().encode(EMERGENCY_KEY_REGISTER_SIGNATURE);
    const hash = keccak_256(sig);
    const bytes = hash.slice(0, 4);
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    _registerSelectorHex = s;
  }
  return _registerSelectorHex;
}

// ────────────────────────────────────────────────────────────────────────────
// Word helpers — same shape as `shared/staking-tx.ts` so the encoded
// hex output composes uniformly with the rest of the wallet's tx
// envelope path.
// ────────────────────────────────────────────────────────────────────────────

/** Encode a `uint16` as a right-aligned 32-byte ABI word. Top 30
 *  bytes are zero. Mirrors `mono-core/crates/precompiles/system/
 *  emergency-key-registry/src/abi.rs::encode_uint16`. */
export function encodeUint16Word(v: number): string {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new RangeError(`encodeUint16Word: not a u16 (${v})`);
  }
  const hi = (v >> 8) & 0xff;
  const lo = v & 0xff;
  // 30 zero bytes + the 2 value bytes = 32-byte word = 64 hex chars.
  return "00".repeat(30) + hi.toString(16).padStart(2, "0") + lo.toString(16).padStart(2, "0");
}

/** Encode a `uint256` (or smaller) as a right-aligned 32-byte word.
 *  Reused for the bytes-body length + the dynamic-offset head word. */
export function encodeUint256Word(value: number | bigint): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= 1n << 256n) {
    throw new RangeError(`encodeUint256Word: out of range (${value})`);
  }
  return n.toString(16).padStart(64, "0");
}

/** Encode a raw byte array as hex (no `0x` prefix). */
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Encode a `bytes` payload according to Solidity's dynamic-bytes
 *  ABI body layout: length word + payload zero-padded to a 32-byte
 *  boundary. */
function encodeBytesBody(payload: Uint8Array): string {
  const lenWord = encodeUint256Word(payload.length);
  const payloadHex = bytesToHex(payload);
  const paddedLen = Math.ceil(payload.length / 32) * 32;
  const padHex = "00".repeat(paddedLen - payload.length);
  return lenWord + payloadHex + padHex;
}

// ────────────────────────────────────────────────────────────────────────────
// Calldata encoder
// ────────────────────────────────────────────────────────────────────────────

/** Encode the full `register(uint16,bytes)` calldata for the wallet's
 *  SLH-DSA-SHA2-128s backup pubkey.
 *
 *  Output is a 0x-prefixed hex string ready for
 *  `bgWalletSendTx({ to, data })`. Layout:
 *
 *  ```text
 *  [selector 4B] [algo word 32B] [bytes offset word 32B = 0x40]
 *  [bytes length word 32B = 32]  [pubkey body 32B]
 *  ```
 *
 *  Total = 4 + 32 + 32 + 32 + 32 = 132 bytes = 264 hex chars (plus
 *  the leading `0x`). */
export function encodeEmergencyKeyRegister(pubkey: Uint8Array): string {
  if (pubkey.length !== SLH_DSA_SHA2_128S_LENGTHS.publicKey) {
    throw new RangeError(
      `encodeEmergencyKeyRegister: pubkey must be ${SLH_DSA_SHA2_128S_LENGTHS.publicKey} bytes, got ${pubkey.length}`,
    );
  }
  const sel = registerSelectorHex().slice(2); // strip 0x
  const algoWord = encodeUint16Word(SLH_DSA_SHA2_128S_ALGO_ID);
  // The bytes-head offset is the byte offset (from the start of
  // args) at which the bytes body begins. We have two head words
  // (algo + offset), so the body starts at byte 64 = 0x40.
  const headOffsetWord = encodeUint256Word(0x40);
  const bytesBody = encodeBytesBody(pubkey);
  return "0x" + sel + algoWord + headOffsetWord + bytesBody;
}

// ────────────────────────────────────────────────────────────────────────────
// Tx-shape builder — what the wallet's existing `bgWalletSendTx`
// IPC accepts.
// ────────────────────────────────────────────────────────────────────────────

/** `bgWalletSendTx({ to, data, value })`-shaped payload for the
 *  emergency-key registration. The `to` is pinned to the precompile
 *  address; `value` is 0 (the precompile is not payable). */
export interface RegisterTxShape {
  to: string;
  data: string;
  valueWeiHex: string;
}

/** Build the full tx-shape for the wallet's send path. */
export function buildEmergencyKeyRegisterTx(
  pubkey: Uint8Array,
): RegisterTxShape {
  return {
    to: EMERGENCY_KEY_PRECOMPILE_ADDRESS,
    data: encodeEmergencyKeyRegister(pubkey),
    valueWeiHex: "0x0",
  };
}
