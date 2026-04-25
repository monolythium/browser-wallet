// Monolythium Wallet — legacy EIP-155 transaction builder.
//
// We deliberately ship a small, hand-rolled RLP encoder rather than pulling
// in ethers. The wallet's other moving parts (keystore, secp256k1) come from
// `@noble/*`; staying in that family keeps bundle size down and avoids a
// transitive surface area we'd need to audit.
//
// Only legacy (type-0) transactions are supported in this stage. Once
// LythiumDAG-BFT exposes EIP-1559-style fee preferences via the SDK we'll
// extend this module — call sites use `buildAndSignLegacyTx` so the upgrade
// is single-call-site.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { signAsync } from "@noble/secp256k1";

export interface LegacyTxRequest {
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  nonce: string;
  chainId: number;
}

// ---- hex helpers ----

function stripHex(s: string | undefined): string {
  if (!s) return "";
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function hexToBytes(s: string | undefined): Uint8Array {
  const r = stripHex(s);
  if (r.length === 0) return new Uint8Array(0);
  // pad odd-length hex on the left so 0x123 -> 0x0123
  const padded = r.length % 2 === 1 ? "0" + r : r;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function quantityToBytes(q: string | undefined): Uint8Array {
  if (!q) return new Uint8Array(0);
  // Strip leading zero bytes per RLP "scalar" rules.
  const raw = hexToBytes(q);
  let i = 0;
  while (i < raw.length && raw[i] === 0) i++;
  return raw.slice(i);
}

function intToBytes(n: number): Uint8Array {
  if (n === 0) return new Uint8Array(0);
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array(out);
}

// ---- RLP encode ----
// Spec: https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/

type RlpInput = Uint8Array | RlpInput[];

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) {
    return new Uint8Array([offset + len]);
  }
  const lenBytes = intToBytes(len);
  const out = new Uint8Array(1 + lenBytes.length);
  out[0] = offset + 55 + lenBytes.length;
  out.set(lenBytes, 1);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function rlpEncode(value: RlpInput): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length === 1 && value[0]! < 0x80) return value;
    return concatBytes([encodeLength(value.length, 0x80), value]);
  }
  // list
  const inner = concatBytes(value.map(rlpEncode));
  return concatBytes([encodeLength(inner.length, 0xc0), inner]);
}

// ---- legacy EIP-155 transaction ----

/**
 * Build the RLP-encoded signing payload, hash it (keccak256), sign with the
 * supplied signer, then build and return the final `0x`-prefixed raw tx +
 * its tx hash.
 *
 * `signHash` returns 65 bytes: r||s||v where v is 27 or 28 (we adjust to
 * EIP-155 v = chainId*2 + 35 + recovery).
 */
export async function buildAndSignLegacyTx(
  req: LegacyTxRequest,
  privKey: Uint8Array,
): Promise<{ rawTx: string; txHash: string }> {
  const fields = [
    quantityToBytes(req.nonce),
    quantityToBytes(req.gasPrice),
    quantityToBytes(req.gas),
    req.to ? hexToBytes(req.to) : new Uint8Array(0),
    quantityToBytes(req.value),
    req.data ? hexToBytes(req.data) : new Uint8Array(0),
    intToBytes(req.chainId),
    new Uint8Array(0),
    new Uint8Array(0),
  ];
  const signingPayload = rlpEncode(fields);
  const signingHash = keccak_256(signingPayload);

  // signAsync with format:"recovered" returns 65 bytes: r(32) || s(32) || recovery(1).
  const sig = await signAsync(signingHash, privKey, {
    prehash: false,
    format: "recovered",
  });
  const r = sig.subarray(0, 32);
  const s = sig.subarray(32, 64);
  const recovery = sig[64]! & 1;
  // EIP-155: v = recovery + 35 + 2 * chainId
  const v = recovery + 35 + 2 * req.chainId;

  const signedFields = [
    fields[0]!, // nonce
    fields[1]!, // gasPrice
    fields[2]!, // gas
    fields[3]!, // to
    fields[4]!, // value
    fields[5]!, // data
    intToBytes(v),
    trimLeadingZeros(r),
    trimLeadingZeros(s),
  ];
  const rawBytes = rlpEncode(signedFields);
  const rawTx = "0x" + bytesToHex(rawBytes);
  const txHash = "0x" + bytesToHex(keccak_256(rawBytes));
  return { rawTx, txHash };
}

function trimLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.slice(i);
}

export const __internal = {
  rlpEncode,
  hexToBytes,
  bytesToHex,
};
