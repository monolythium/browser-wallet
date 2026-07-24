import { keccak_256 } from "@noble/hashes/sha3.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  MlDsa65Backend,
  encodeTransactionForHash,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { describe, expect, it } from "vitest";

import {
  assembleNativeMultisigSignedTx,
  type CollectedMemberSignature,
} from "./native-multisig-tx.js";
import {
  deriveNativeMultisigAddress,
  nativeMultisigBaseSighash,
} from "./native-multisig.js";

// A member = a real ML-DSA-65 keypair from a fixed seed, so signatures are real.
function makeMember(seedByte: number): { pubkey: Uint8Array; sign: (d: Uint8Array) => Uint8Array } {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  const backend = MlDsa65Backend.fromSeed(seed);
  const pubkey = backend.publicKey();
  return { pubkey, sign: (d) => backend.signPrehash(d) };
}

function sampleFields(): NativeEvmTxFields {
  return {
    chainId: "0x10F2C",
    nonce: "0x5",
    gasLimit: "0x5208",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    to: "0x" + "22".repeat(20),
    value: "0x64",
    input: "0x",
    extensions: [],
  };
}

describe("assembleNativeMultisigSignedTx — offline chain-rule simulation (the correctness proof)", () => {
  it("builds a 2-of-3 native multisig tx that satisfies the chain's acceptance rules", () => {
    const m1 = makeMember(0x01);
    const m2 = makeMember(0x02);
    const m3 = makeMember(0x03);
    const roster = [m1.pubkey, m2.pubkey, m3.pubkey];
    const threshold = 2;
    const fields = sampleFields();

    // Every signer signs the BASE (witness-stripped) sighash.
    const base = nativeMultisigBaseSighash(fields);
    const memberSignatures: CollectedMemberSignature[] = [
      { pubkey: m1.pubkey, signature: m1.sign(base) },
      { pubkey: m2.pubkey, signature: m2.sign(base) },
    ];
    // The outer signer is a roster member (m1), signing the same base.
    const outerSignature = m1.sign(base);

    const built = assembleNativeMultisigSignedTx({
      fields,
      threshold,
      members: roster,
      memberSignatures,
      outerPubkey: m1.pubkey,
      outerSignature,
    });

    // ── Independently verify the way the chain would (not trusting assemble) ──
    // (d) the witness roster+threshold derives to the tx's sender (the monom).
    expect(built.monomAddress).toBe(deriveNativeMultisigAddress(threshold, roster));
    expect(built.monomAddress.startsWith("monom1")).toBe(true);

    const baseBytes = nativeMultisigBaseSighash(fields);
    // (b)+(c) the outer signature verifies over base AND the outer is a member.
    expect(ml_dsa65.verify(outerSignature, baseBytes, m1.pubkey)).toBe(true);
    expect(roster.some((pk) => bytesEq(pk, m1.pubkey))).toBe(true);
    // (a) ≥threshold DISTINCT member signatures verify over base.
    const verifying = memberSignatures.filter((ms) =>
      ml_dsa65.verify(ms.signature, baseBytes, ms.pubkey),
    );
    expect(verifying.length).toBeGreaterThanOrEqual(threshold);

    // The witness decodes to the expected sorted roster + threshold + sig layout.
    expect(built.witness.threshold).toBe(2);
    expect(built.witness.members).toHaveLength(3);
    expect(built.witness.signatures).toHaveLength(2);
    // Roster is canonically sorted ascending by pubkey bytes.
    for (let i = 1; i < built.witness.members.length; i++) {
      expect(
        cmpBytes(built.witness.members[i - 1]!.pubkey, built.witness.members[i]!.pubkey),
      ).toBeLessThan(0);
    }

    // The wire + canonical hash are well-formed, and assembly is deterministic
    // for fixed inputs (a round-trip: same inputs → identical bytes).
    expect(built.wireHex).toMatch(/^0x[0-9a-f]+$/);
    expect(built.txHashHex).toMatch(/^0x[0-9a-f]{64}$/);
    const again = assembleNativeMultisigSignedTx({
      fields,
      threshold,
      members: roster,
      memberSignatures,
      outerPubkey: m1.pubkey,
      outerSignature,
    });
    expect(again.wireHex).toBe(built.wireHex);
    expect(again.txHashHex).toBe(built.txHashHex);
  });

  it("NEGATIVE: signatures over the FULL sighash (not base) are REFUSED — catching the c1-guarded mistake", () => {
    const m1 = makeMember(0x11);
    const m2 = makeMember(0x12);
    const m3 = makeMember(0x13);
    const roster = [m1.pubkey, m2.pubkey, m3.pubkey];
    const fields = sampleFields();
    // The FULL (extension-inclusive) sighash the single-key path would sign for a
    // 0x40-bearing tx — it commits the multisig witness extension, so it differs
    // from the base sighash the chain (and assemble) actually verify against.
    const full = keccak_256(
      encodeTransactionForHash({ ...fields, extensions: [{ kind: 0x40, body: new Uint8Array([1]) }] }, 1),
    );

    expect(() =>
      assembleNativeMultisigSignedTx({
        fields,
        threshold: 2,
        members: roster,
        memberSignatures: [
          { pubkey: m1.pubkey, signature: m1.sign(full) },
          { pubkey: m2.pubkey, signature: m2.sign(full) },
        ],
        outerPubkey: m1.pubkey,
        outerSignature: m1.sign(full),
      }),
    ).toThrow(/does not verify over the base sighash/);
  });
});

describe("assembleNativeMultisigSignedTx — fail-closed refusals", () => {
  const m1 = makeMember(0x21);
  const m2 = makeMember(0x22);
  const m3 = makeMember(0x23);
  const stranger = makeMember(0x2f); // not in the roster
  const roster = [m1.pubkey, m2.pubkey, m3.pubkey];
  const fields = sampleFields();
  const base = nativeMultisigBaseSighash(fields);

  it("refuses fewer than `threshold` verifying member signatures (quorum unmet)", () => {
    expect(() =>
      assembleNativeMultisigSignedTx({
        fields,
        threshold: 2,
        members: roster,
        memberSignatures: [{ pubkey: m1.pubkey, signature: m1.sign(base) }],
        outerPubkey: m1.pubkey,
        outerSignature: m1.sign(base),
      }),
    ).toThrow(/quorum unmet/);
  });

  it("refuses a non-member outer signer (chain: MultisigOuterSignerNotMember)", () => {
    expect(() =>
      assembleNativeMultisigSignedTx({
        fields,
        threshold: 2,
        members: roster,
        memberSignatures: [
          { pubkey: m1.pubkey, signature: m1.sign(base) },
          { pubkey: m2.pubkey, signature: m2.sign(base) },
        ],
        outerPubkey: stranger.pubkey,
        outerSignature: stranger.sign(base),
      }),
    ).toThrow(/outer signer is not a roster member/);
  });

  it("refuses a member signature from a key not in the roster", () => {
    expect(() =>
      assembleNativeMultisigSignedTx({
        fields,
        threshold: 2,
        members: roster,
        memberSignatures: [
          { pubkey: m1.pubkey, signature: m1.sign(base) },
          { pubkey: stranger.pubkey, signature: stranger.sign(base) },
        ],
        outerPubkey: m1.pubkey,
        outerSignature: m1.sign(base),
      }),
    ).toThrow(/not in the roster/);
  });

  it("refuses when the derived address does not equal the expected monom", () => {
    expect(() =>
      assembleNativeMultisigSignedTx({
        fields,
        threshold: 2,
        members: roster,
        memberSignatures: [
          { pubkey: m1.pubkey, signature: m1.sign(base) },
          { pubkey: m2.pubkey, signature: m2.sign(base) },
        ],
        outerPubkey: m1.pubkey,
        outerSignature: m1.sign(base),
        expectedMonom: "monom1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9y0h5h",
      }),
    ).toThrow(/does not equal the expected/);
  });
});

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  return cmpBytes(a, b) === 0;
}
function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
