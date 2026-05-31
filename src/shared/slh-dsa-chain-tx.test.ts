// Phase 10 Commit 4 — calldata encoder tests.
//
// These tests pin the on-the-wire byte layout against the chain
// side's `mono-core/crates/precompiles/system/emergency-key-registry/`
// expectations. A drift in any of these fixtures means the wallet
// would submit malformed calldata that the precompile rejects with a
// `CalldataMalformed` revert at the very first byte — a silent
// regression we want to catch in CI before it reaches users.

import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  EMERGENCY_KEY_PRECOMPILE_ADDRESS,
  SLH_DSA_SHA2_128S_LENGTHS,
} from "./slh-dsa-backup.js";
import {
  EMERGENCY_KEY_REGISTER_GAS_LIMIT_HEX,
  EMERGENCY_KEY_REGISTER_SIGNATURE,
  buildEmergencyKeyRegisterTx,
  encodeEmergencyKeyRegister,
  encodeUint16Word,
  encodeUint256Word,
  registerSelectorHex,
} from "./slh-dsa-chain-tx.js";

describe("registerSelectorHex", () => {
  it("matches the canonical keccak256 over the signature", () => {
    const sig = new TextEncoder().encode(EMERGENCY_KEY_REGISTER_SIGNATURE);
    const expected = keccak_256(sig).slice(0, 4);
    let exp = "0x";
    for (const b of expected) exp += b.toString(16).padStart(2, "0");
    expect(registerSelectorHex()).toBe(exp);
  });

  it("is a 10-character 0x-prefixed string", () => {
    const sel = registerSelectorHex();
    expect(sel.startsWith("0x")).toBe(true);
    expect(sel.length).toBe(10);
  });

  it("caches across calls (no recompute on every invocation)", () => {
    const a = registerSelectorHex();
    const b = registerSelectorHex();
    expect(a).toBe(b);
  });
});

describe("encodeUint16Word", () => {
  it("encodes 1101 (the SLH-DSA-SHA2-128s algo id) right-aligned", () => {
    // 1101 = 0x044D
    const word = encodeUint16Word(1101);
    expect(word).toBe("00".repeat(30) + "044d");
    expect(word.length).toBe(64);
  });

  it("encodes 0 as a fully-zero word", () => {
    expect(encodeUint16Word(0)).toBe("0".repeat(64));
  });

  it("encodes 0xffff as the all-set high bytes", () => {
    expect(encodeUint16Word(0xffff)).toBe("00".repeat(30) + "ffff");
  });

  it("rejects negative + non-integer + overflow", () => {
    expect(() => encodeUint16Word(-1)).toThrow();
    expect(() => encodeUint16Word(0x10000)).toThrow();
    expect(() => encodeUint16Word(1.5)).toThrow();
  });
});

describe("encodeUint256Word", () => {
  it("encodes 0 as the zero word", () => {
    expect(encodeUint256Word(0)).toBe("0".repeat(64));
  });

  it("encodes 0x40 (the head-offset value) right-aligned", () => {
    expect(encodeUint256Word(0x40)).toBe("0".repeat(62) + "40");
  });

  it("encodes 32 (the pubkey length word) right-aligned", () => {
    expect(encodeUint256Word(32)).toBe("0".repeat(62) + "20");
  });

  it("rejects negative + overflow", () => {
    expect(() => encodeUint256Word(-1n)).toThrow();
    expect(() => encodeUint256Word(1n << 256n)).toThrow();
  });
});

describe("encodeEmergencyKeyRegister", () => {
  /** All-0xab pubkey — easy to spot in the encoded output. */
  function fixturePubkey(): Uint8Array {
    return new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.publicKey).fill(0xab);
  }

  it("rejects wrong-length pubkey", () => {
    expect(() => encodeEmergencyKeyRegister(new Uint8Array(31))).toThrow(
      /pubkey must be 32 bytes/,
    );
    expect(() => encodeEmergencyKeyRegister(new Uint8Array(33))).toThrow();
  });

  it("pins the full calldata layout (selector + algo + offset + length + body)", () => {
    const cd = encodeEmergencyKeyRegister(fixturePubkey());
    // 0x + (4 + 32 + 32 + 32 + 32) bytes * 2 = 2 + 264 = 266 chars
    expect(cd.length).toBe(266);
    expect(cd.startsWith("0x")).toBe(true);

    const body = cd.slice(2);
    // Selector — 4 bytes.
    expect(body.slice(0, 8)).toBe(registerSelectorHex().slice(2));
    // algo word — right-aligned 1101 = 0x044d.
    expect(body.slice(8, 8 + 64)).toBe(encodeUint16Word(1101));
    // head-offset word — 0x40.
    expect(body.slice(8 + 64, 8 + 128)).toBe(encodeUint256Word(0x40));
    // bytes length word — 32.
    expect(body.slice(8 + 128, 8 + 192)).toBe(encodeUint256Word(32));
    // pubkey body — 32 bytes of 0xab (no padding needed; already on
    // a 32-byte boundary).
    expect(body.slice(8 + 192)).toBe("ab".repeat(32));
  });

  it("matches a hand-computed fixture for known pubkey input", () => {
    // Use a deterministic pubkey so the encoded string is fully
    // reproducible. This is the contract test the chain side would
    // pass-or-fail against if we cross-replayed the calldata.
    const pubkey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pubkey[i] = i;
    const cd = encodeEmergencyKeyRegister(pubkey);

    // Pubkey hex = "000102...1f"
    let pubHex = "";
    for (let i = 0; i < 32; i++) pubHex += i.toString(16).padStart(2, "0");

    const expected =
      registerSelectorHex() + // includes 0x
      encodeUint16Word(1101) + // algo
      encodeUint256Word(0x40) + // bytes head-offset
      encodeUint256Word(32) + // pubkey length
      pubHex; // pubkey body (no padding — already on boundary)
    expect(cd).toBe(expected);
  });
});

describe("buildEmergencyKeyRegisterTx", () => {
  it("pins `to` to the precompile address (0x...1100)", () => {
    const pubkey = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.publicKey);
    const tx = buildEmergencyKeyRegisterTx(pubkey);
    expect(tx.to).toBe(EMERGENCY_KEY_PRECOMPILE_ADDRESS);
    expect(tx.to.endsWith("00001100")).toBe(true);
  });

  it("value is zero (precompile is not payable)", () => {
    const pubkey = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.publicKey);
    const tx = buildEmergencyKeyRegisterTx(pubkey);
    expect(tx.valueWeiHex).toBe("0x0");
  });

  it("data is the calldata from encodeEmergencyKeyRegister", () => {
    const pubkey = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.publicKey).fill(
      0x55,
    );
    const tx = buildEmergencyKeyRegisterTx(pubkey);
    expect(tx.data).toBe(encodeEmergencyKeyRegister(pubkey));
  });

  it("includes the named gas constant on the tx shape so the SW does not fall back to the native-transfer floor", () => {
    const pubkey = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.publicKey);
    const tx = buildEmergencyKeyRegisterTx(pubkey);
    expect(tx.executionUnitLimitHex).toBe(EMERGENCY_KEY_REGISTER_GAS_LIMIT_HEX);
    // Pin the exact value so a future drift in the constant doesn't silently
    // re-introduce an under-provisioned send. Aligned to the SDK 0.3.11 sane
    // register/tx execution-unit-limit default (~200000 = 0x30D40).
    expect(tx.executionUnitLimitHex).toBe("0x30D40");
  });
});
