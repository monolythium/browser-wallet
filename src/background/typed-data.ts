// Monolythium Wallet — EIP-712 / EIP-191 byte helpers.
//
// Pure utilities, no vault concept: hex/utf8 decoding for personal_sign
// payloads and the EIP-712 v4 typed-data digest. Extracted from the
// (deleted) legacy secp256k1 keystore so the v4 ML-DSA module and the SW
// approval-digest preview can share them without importing v3 vault code.
// Depends only on keccak-256.

import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Thrown by the EIP-712 encoder when a field cannot be encoded faithfully to
 * its declared type. The encoder REJECTS rather than coerces (#29): silently
 * coercing a malformed field would sign a digest that differs from what the
 * dApp asked the user to approve — an invisible WYSIWYS break. The caller
 * (approval-preview + sign path) catches this and surfaces it as a rejection.
 */
export class TypedDataError extends Error {
  constructor(detail: string) {
    super(`invalid typed-data field: ${detail}`);
    this.name = "TypedDataError";
  }
}

/** Decode a personal_sign payload: a `0x`-prefixed even-length hex string
 *  becomes raw bytes, anything else is UTF-8. Matches the lenient wallet
 *  behaviour dapp libraries expect. */
export function hexOrUtf8ToBytes(s: string): Uint8Array {
  if (s.startsWith("0x") || s.startsWith("0X")) {
    const rest = s.slice(2);
    const len = rest.length / 2;
    if (!Number.isInteger(len)) {
      // Fall back to utf8 if it's not even hex.
      return new TextEncoder().encode(s);
    }
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = parseInt(rest.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return new TextEncoder().encode(s);
}

/**
 * Compute the 32-byte EIP-712 v4 digest for a typed-data envelope. Pure
 * function — exported so the popup can preview the digest before the user
 * commits and so tests can assert against fixtures.
 */
export function computeTypedDataDigest(envelope: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): Uint8Array {
  const domainHash = hashStruct("EIP712Domain", envelope.domain, {
    EIP712Domain: domainTypeFor(envelope.domain),
    ...envelope.types,
  });
  const messageHash = hashStruct(envelope.primaryType, envelope.message, {
    EIP712Domain: domainTypeFor(envelope.domain),
    ...envelope.types,
  });
  const out = new Uint8Array(2 + 32 + 32);
  out[0] = 0x19;
  out[1] = 0x01;
  out.set(domainHash, 2);
  out.set(messageHash, 34);
  return keccak_256(out);
}

// Build the `EIP712Domain` type list to match the populated keys in `domain`.
// EIP-712 spec: only the fields actually present in `domain` are encoded, so
// the type list shrinks accordingly.
function domainTypeFor(
  domain: Record<string, unknown>,
): Array<{ name: string; type: string }> {
  const candidates: Array<{ name: string; type: string }> = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ];
  return candidates.filter((c) => domain[c.name] !== undefined);
}

function hashStruct(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const enc = encodeData(primaryType, data, types);
  return keccak_256(enc);
}

function encodeType(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): string {
  const deps = collectTypeDeps(primaryType, types, new Set());
  deps.delete(primaryType);
  const sorted = [primaryType, ...Array.from(deps).sort()];
  return sorted
    .map((t) => {
      const fields = types[t] ?? [];
      return `${t}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    })
    .join("");
}

function collectTypeDeps(
  type: string,
  types: Record<string, Array<{ name: string; type: string }>>,
  found: Set<string>,
): Set<string> {
  const base = type.replace(/\[.*\]/g, "");
  if (found.has(base)) return found;
  if (!types[base]) return found;
  found.add(base);
  for (const f of types[base]) {
    collectTypeDeps(f.type, types, found);
  }
  return found;
}

function typeHash(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  return keccak_256(new TextEncoder().encode(encodeType(primaryType, types)));
}

function encodeData(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const fields = types[primaryType] ?? [];
  const head: Uint8Array[] = [typeHash(primaryType, types)];
  for (const f of fields) {
    head.push(encodeValue(f.type, data[f.name], types));
  }
  return concat(head);
}

function encodeValue(
  type: string,
  value: unknown,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  // Arrays — T[] dynamic, T[N] fixed.
  const arr = type.match(/^(.+)\[(\d*)\]$/);
  if (arr) {
    const inner = arr[1]!;
    if (!Array.isArray(value)) {
      throw new TypedDataError(`expected an array for type "${type}"`);
    }
    const fixed = arr[2]!;
    if (fixed !== "" && value.length !== Number(fixed)) {
      throw new TypedDataError(
        `array "${type}" expects ${fixed} items, got ${value.length}`,
      );
    }
    const parts = value.map((v) => encodeValue(inner, v, types));
    return keccak_256(concat(parts));
  }
  // Nested struct
  if (types[type]) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypedDataError(`expected an object for struct "${type}"`);
    }
    return hashStruct(type, value as Record<string, unknown>, types);
  }
  if (type === "string") {
    if (typeof value !== "string") {
      throw new TypedDataError(`expected a string for a "string" field`);
    }
    return keccak_256(new TextEncoder().encode(value));
  }
  if (type === "bytes") {
    return keccak_256(parseBytesStrict(value, type));
  }
  if (type === "bool") {
    // Tolerance (iv): JS booleans only. Truthiness coercion is the dangerous
    // status quo (the string "false" is truthy → would sign as true).
    if (typeof value !== "boolean") {
      throw new TypedDataError(`expected a boolean for a "bool" field`);
    }
    return leftPad32(new Uint8Array([value ? 1 : 0]));
  }
  if (type === "address") {
    // Tolerance (i): any-case 20-byte hex. NO lowercase-only requirement (would
    // reject every EIP-55 mixed-case address) and NO EIP-55 checksum enforcement
    // (the contract only ever sees the 20 bytes).
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new TypedDataError(`expected a 20-byte 0x-hex address (any case)`);
    }
    return leftPad32(parseHexBytes(value));
  }
  // Fixed-size byte arrays bytes1..bytes32.
  const bytesN = type.match(/^bytes([0-9]+)$/);
  if (bytesN) {
    const n = Number(bytesN[1]!);
    if (n < 1 || n > 32) {
      throw new TypedDataError(`invalid fixed-bytes width "${type}"`);
    }
    const b = parseBytesStrict(value, type);
    if (b.length !== n) {
      throw new TypedDataError(`"${type}" expects ${n} bytes, got ${b.length}`);
    }
    return rightPad32(b);
  }
  // Integers uint / uintN / int / intN.
  const numMatch = type.match(/^(u?int)([0-9]*)$/);
  if (numMatch) {
    const signed = numMatch[1] === "int";
    return leftPad32(intToBytesBEStrict(value, signed, type));
  }
  // Unknown / unresolved type — REJECT (no String() coercion fallback). This is
  // the highest-severity coercion: it would otherwise hash an arbitrary field as
  // free text and sign a digest unrelated to the declared type.
  throw new TypedDataError(`unsupported or unknown EIP-712 type "${type}"`);
}

function parseBytesStrict(value: unknown, type: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return parseHexBytesStrict(value, type);
  throw new TypedDataError(
    `expected 0x-hex or a byte array for a "${type}" field`,
  );
}

function parseHexBytesStrict(s: string, type: string): Uint8Array {
  // Even number of hex digits after 0x. "0x" (empty) is valid for dynamic
  // `bytes`; a bytesN length check rejects it where a fixed width is required.
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) {
    throw new TypedDataError(
      `malformed hex for "${type}" (need 0x + an even number of hex digits)`,
    );
  }
  const r = s.slice(2);
  const out = new Uint8Array(r.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(r.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function parseHexBytes(s: string): Uint8Array {
  const r = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (r.length === 0) return new Uint8Array(0);
  const padded = r.length % 2 === 1 ? "0" + r : r;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function intToBytesBEStrict(
  value: unknown,
  signed: boolean,
  type: string,
): Uint8Array {
  let n: bigint;
  if (typeof value === "bigint") {
    n = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypedDataError(`"${type}" value is not an integer: ${value}`);
    }
    n = BigInt(value);
  } else if (typeof value === "string") {
    // Tolerance (ii): representation-agnostic. Accept decimal or 0x-hex strings;
    // BigInt() tolerates surrounding whitespace, so " 5 " === "5" stays
    // digest-identical with the pre-strict encoder. Empty string keeps its
    // legacy meaning of 0. Anything BigInt cannot parse is rejected.
    try {
      n = BigInt(value === "" ? "0" : value);
    } catch {
      throw new TypedDataError(`"${type}" value is not a valid integer: ${value}`);
    }
  } else {
    throw new TypedDataError(
      `"${type}" value has an unsupported type: ${value === null ? "null" : typeof value}`,
    );
  }
  // Tolerance (iii): ceiling-only range + signedness. Per-declared-width N is
  // intentionally NOT enforced — a real Solidity verifier does not range-check
  // per width at abi.encode time, so rejecting e.g. uint8=300 could reject a
  // contract-valid signature.
  if (signed) {
    const min = -(1n << 255n);
    const max = (1n << 255n) - 1n;
    if (n < min || n > max) {
      throw new TypedDataError(`"${type}" value out of int256 range: ${n}`);
    }
    if (n < 0n) {
      n = (1n << 256n) + n; // two's-complement for signed types
    }
  } else {
    if (n < 0n) {
      throw new TypedDataError(`negative value for unsigned "${type}": ${n}`);
    }
    if (n > (1n << 256n) - 1n) {
      throw new TypedDataError(`"${type}" value out of uint256 range: ${n}`);
    }
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return parseHexBytes(hex);
}

function leftPad32(b: Uint8Array): Uint8Array {
  if (b.length >= 32) return b.slice(b.length - 32);
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

function rightPad32(b: Uint8Array): Uint8Array {
  if (b.length >= 32) return b.slice(0, 32);
  const out = new Uint8Array(32);
  out.set(b, 0);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
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
