import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  MlDsa65Backend,
  bytesToHex,
  hexToBytes,
  encodeTransactionForHash,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { describe, expect, it } from "vitest";

import {
  deriveNativeMultisigAddress,
  deriveNativeMultisigAddressBytes,
  nativeMultisigBaseSighash,
  buildNativeMultisigWitness,
  attachNativeMultisigWitness,
  encodeNativeMultisigWitnessBody,
  nativeMultisigMemberIndex,
  carriesMultisigExtension,
  TX_EXTENSION_KIND_MULTISIG,
} from "./native-multisig.js";

// ─────────────────────────────────────────────────────────────────────────────
// FUND-LOSS-CRITICAL known-answer test (KAT).
//
// Provenance (a REAL mono-core vector, NOT a self-referential SDK-vs-SDK check):
//   The testnet foundation multisig is 5-of-... no — 3-of-5. Its five members are
//   derived deterministically from `testnet_foundation_seed(idx)` = the 32-byte
//   seed `[0xF0, idx, 0×30]` (mono-core `core/cli/.../testnet.rs:96-101`,
//   TESTNET_FOUNDATION_SEED_TAG = 0xF0), each fed to ML-DSA-65 KeyGen_internal
//   (FIPS-204 Algorithm 6; mono-core `crypto/.../ml_dsa.rs:205-223`). The threshold
//   is 3 (TESTNET_FOUNDATION_THRESHOLD). The derived address is PINNED IN GENESIS
//   as `monom16ets48dm0guclykv2hf2z7utnrarlhyw9az7nn` = raw 20 bytes
//   `0xd6570a9dbb7a398f92cc55d2a17b8b98fa3fdc8e` (mono-core `core/runtime/.../config.rs:274`
//   `TESTNET_FOUNDATION_MULTISIG`; asserted in `runtime/.../testnet_bringup.rs`).
//
//   The wallet's `MlDsa65Backend.fromSeed(seed)` = the SAME FIPS-204 KeyGen_internal
//   (noble `ml_dsa65.keygen(seed)`; the exact primitive the whole keystore relies
//   on for chain-matching addresses), so reproducing the five member pubkeys from
//   the 0xF0 seeds and deriving via the SDK MUST reproduce the genesis-pinned
//   `monom`. A wrong derivation = funds sent to an unspendable address.
// ─────────────────────────────────────────────────────────────────────────────

const KAT_THRESHOLD = 3;
const KAT_MEMBER_COUNT = 5;
const KAT_SEED_TAG = 0xf0;
const KAT_EXPECTED_MONOM = "monom16ets48dm0guclykv2hf2z7utnrarlhyw9az7nn";
const KAT_EXPECTED_BYTES = "0xd6570a9dbb7a398f92cc55d2a17b8b98fa3fdc8e";

function foundationSeed(idx: number): Uint8Array {
  const s = new Uint8Array(32);
  s[0] = KAT_SEED_TAG;
  s[1] = idx;
  return s;
}

function foundationMemberPubkeys(): Uint8Array[] {
  const members: Uint8Array[] = [];
  for (let idx = 1; idx <= KAT_MEMBER_COUNT; idx++) {
    const backend = MlDsa65Backend.fromSeed(foundationSeed(idx));
    members.push(backend.publicKey());
    backend.dispose();
  }
  return members;
}

describe("deriveNativeMultisigAddress — genesis-pinned foundation KAT (fund-loss-critical)", () => {
  it("derives the mono-core-pinned foundation monom byte-exactly", () => {
    const members = foundationMemberPubkeys();
    expect(members).toHaveLength(5);
    expect(members[0]).toHaveLength(1952); // canonical ML-DSA-65 pubkey length

    expect(deriveNativeMultisigAddress(KAT_THRESHOLD, members)).toBe(KAT_EXPECTED_MONOM);
    // Corroborate the raw 20 address bytes against the genesis constant.
    expect(bytesToHex(deriveNativeMultisigAddressBytes(KAT_THRESHOLD, members))).toBe(
      bytesToHex(hexToBytes(KAT_EXPECTED_BYTES)),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Base sighash — strips the 0x40 witness; differs from the full sighash.
// ─────────────────────────────────────────────────────────────────────────────

function sampleFields(extensions: NativeEvmTxFields["extensions"]): NativeEvmTxFields {
  return {
    chainId: "0x10F2C",
    nonce: "0x0",
    gasLimit: "0x5208",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    to: "0x" + "11".repeat(20),
    value: "0x0",
    input: "0x",
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

describe("nativeMultisigBaseSighash — witness-stripped, differs from the full sighash", () => {
  it("strips the 0x40 witness → base differs from the full (extension-inclusive) sighash", () => {
    const withExt = sampleFields([{ kind: TX_EXTENSION_KIND_MULTISIG, body: new Uint8Array([1, 2, 3]) }]);
    const base = nativeMultisigBaseSighash(withExt);
    const full = keccak_256(encodeTransactionForHash(withExt, 1));
    expect(bytesToHex(base)).not.toBe(bytesToHex(full));
  });

  it("base is invariant to attaching the 0x40 witness (base(withExt) == base(noExt))", () => {
    const noExt = sampleFields([]);
    const withExt = sampleFields([{ kind: TX_EXTENSION_KIND_MULTISIG, body: new Uint8Array([9, 9]) }]);
    expect(bytesToHex(nativeMultisigBaseSighash(withExt))).toBe(
      bytesToHex(nativeMultisigBaseSighash(noExt)),
    );
  });

  it("with NO 0x40 extension, base == full sighash", () => {
    const noExt = sampleFields([]);
    expect(bytesToHex(nativeMultisigBaseSighash(noExt))).toBe(
      bytesToHex(keccak_256(encodeTransactionForHash(noExt, 1))),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Witness assembly — sorted roster, memberIndex, and the wire body layout.
// ─────────────────────────────────────────────────────────────────────────────

function member(fill: number): Uint8Array {
  return new Uint8Array(1952).fill(fill);
}

describe("buildNativeMultisigWitness — roster + body layout", () => {
  it("sorts the roster ascending and keys memberIndex to the sorted order", () => {
    const a = member(1);
    const b = member(2);
    // Supplied out of order; the witness sorts ascending (a before b).
    const witness = buildNativeMultisigWitness(1, [b, a], []);
    expect(witness.threshold).toBe(1);
    expect(witness.members).toHaveLength(2);
    expect(bytesToHex(witness.members[0]!.pubkey)).toBe(bytesToHex(a));
    expect(nativeMultisigMemberIndex([b, a], a)).toBe(0);
    expect(nativeMultisigMemberIndex([b, a], b)).toBe(1);
  });

  it("encodes the body as 0x01 || \"MONO_MULTISIG_WITNESS_V1\" || bincode", () => {
    const witness = buildNativeMultisigWitness(1, [member(1), member(2)], []);
    const body = encodeNativeMultisigWitnessBody(witness);
    expect(body[0]).toBe(0x01);
    const domain = new TextEncoder().encode("MONO_MULTISIG_WITNESS_V1");
    expect(bytesToHex(body.slice(1, 1 + domain.length))).toBe(bytesToHex(domain));
  });

  it("attachNativeMultisigWitness appends a 0x40 extension to the fields", () => {
    const fields = sampleFields([]);
    const witness = buildNativeMultisigWitness(1, [member(1), member(2)], []);
    const attached = attachNativeMultisigWitness(fields, witness);
    expect(carriesMultisigExtension(attached.extensions)).toBe(true);
  });
});

describe("deriveNativeMultisigAddress — order-insensitive + threshold-sensitive", () => {
  it("same members in any order → same address; different threshold → different address", () => {
    const a = member(1);
    const b = member(2);
    const c = member(3);
    const forward = deriveNativeMultisigAddress(2, [a, b, c]);
    const reversed = deriveNativeMultisigAddress(2, [c, b, a]);
    const threeOfThree = deriveNativeMultisigAddress(3, [a, b, c]);
    expect(forward).toBe(reversed);
    expect(forward).not.toBe(threeOfThree);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chokepoint guard predicate.
// ─────────────────────────────────────────────────────────────────────────────

describe("carriesMultisigExtension — the 0x40 chokepoint guard predicate", () => {
  it("true for a 0x40 (multisig) extension", () => {
    expect(carriesMultisigExtension([{ kind: TX_EXTENSION_KIND_MULTISIG }])).toBe(true);
  });
  it("false for no extensions", () => {
    expect(carriesMultisigExtension(undefined)).toBe(false);
    expect(carriesMultisigExtension([])).toBe(false);
  });
  it("false for a non-0x40 extension (e.g. MRV v1, kind 0x30)", () => {
    expect(carriesMultisigExtension([{ kind: 0x30 }])).toBe(false);
  });
  it("true when a 0x40 is mixed with a non-0x40", () => {
    expect(carriesMultisigExtension([{ kind: 0x30 }, { kind: TX_EXTENSION_KIND_MULTISIG }])).toBe(true);
  });
});
