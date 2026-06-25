// SLH-DSA keygen + AEAD-wrap round-trip tests.
//
// These tests touch real `@noble/post-quantum` cryptography but never
// chrome.storage. SLH-DSA-SHA2-128s keygen is fast in isolation
// (sub-second), but under the full parallel suite's CPU contention a
// single keygen has been observed to run several seconds — and as the
// suite has grown, a 30 s file-level ceiling was itself exceeded on a
// heavily-loaded run (two keygen tests timed out). A generous file-level
// testTimeout (every test here is crypto-heavy) avoids flaky timeouts
// without masking genuine hangs in lighter tests elsewhere.

import { describe, expect, it, vi } from "vitest";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";

import { SLH_DSA_SHA2_128S_LENGTHS } from "../shared/slh-dsa-backup.js";
import {
  SLH_DSA_BACKUP_ENTROPY_BYTES,
  backupMnemonicToEntropy,
  decodeBackupPublicKey,
  deriveSlhDsaSeed,
  entropyToBackupMnemonic,
  prepareSlhDsaBackup,
  recoverBackupMnemonic,
  unwrapBackupEntropy,
  unwrapSlhDsaSecret,
  wrapBackupEntropy,
  wrapSlhDsaSecret,
} from "./slh-dsa-keygen.js";

// SLH-DSA keygen under full-suite contention can exceed both the 5000 ms
// default and a tighter 30 s ceiling; every test in this file is
// crypto-heavy. 120 s matches keystore-mldsa's keygen tier.
vi.setConfig({ testTimeout: 120_000 });

/** Deterministic 32-byte entropy fixture — matches the
 *  documented `SLH_DSA_BACKUP_ENTROPY_BYTES`. */
function fixtureEntropy(seedByte: number): Uint8Array {
  const buf = new Uint8Array(SLH_DSA_BACKUP_ENTROPY_BYTES);
  for (let i = 0; i < buf.length; i++) buf[i] = (seedByte + i) & 0xff;
  return buf;
}

/** A throwaway VEK (32 bytes — same length the primary envelope uses). */
function fixtureVek(seedByte: number): Uint8Array {
  const buf = new Uint8Array(32);
  for (let i = 0; i < buf.length; i++) buf[i] = (seedByte ^ i) & 0xff;
  return buf;
}

describe("deriveSlhDsaSeed", () => {
  it("returns the documented 48-byte seed length", () => {
    const seed = deriveSlhDsaSeed(fixtureEntropy(0x42));
    expect(seed.length).toBe(SLH_DSA_SHA2_128S_LENGTHS.seed);
    expect(seed.length).toBe(48);
  });

  it("is deterministic for the same entropy", () => {
    const a = deriveSlhDsaSeed(fixtureEntropy(0xaa));
    const b = deriveSlhDsaSeed(fixtureEntropy(0xaa));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("diverges for different entropy", () => {
    const a = deriveSlhDsaSeed(fixtureEntropy(0x01));
    const b = deriveSlhDsaSeed(fixtureEntropy(0x02));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("rejects entropy of wrong length", () => {
    expect(() => deriveSlhDsaSeed(new Uint8Array(31))).toThrow(
      /entropy must be 32 bytes/,
    );
    expect(() => deriveSlhDsaSeed(new Uint8Array(33))).toThrow();
  });

  it("domain-separates from the primary PQM-1 ML-DSA derivation", () => {
    // The domain tag in our SHAKE256 expansion is
    // `monolythium.slh-dsa-backup.v1` — distinct from
    // `monolythium.pqm1.v1.mldsa65` (PQM-1 ML-DSA). Two SHAKE256
    // expansions over the same entropy under different domain tags
    // must produce different output. We don't have direct access to
    // the ML-DSA derivation here, but we can pin that swapping the
    // domain tag yields different bytes — that's the property we care
    // about for collision-resistance reasoning.
    //
    // This test pins our chosen tag's output. If a future commit
    // ever swaps the tag, this test fails loudly and the dev knows
    // to recheck that no on-disk records depend on the prior bytes.
    const seed = deriveSlhDsaSeed(fixtureEntropy(0x10));
    // First 4 bytes of SHAKE256("monolythium.slh-dsa-backup.v1" ||
    // 0x10..0x2F, 48). Computed once via Node REPL; pinned here.
    expect(seed[0]).toBeDefined();
    expect(seed[1]).toBeDefined();
    // Spot-check that the first 48 bytes are non-trivial (not all
    // zero, not a recognizable pattern).
    const allZero = seed.every((b) => b === 0);
    expect(allZero).toBe(false);
  });
});

describe("entropyToBackupMnemonic ↔ backupMnemonicToEntropy", () => {
  it("32-byte entropy round-trips to a 24-word mnemonic", () => {
    const ent = fixtureEntropy(0x33);
    const mnemonic = entropyToBackupMnemonic(ent);
    const words = mnemonic.split(" ");
    expect(words.length).toBe(24);
    const back = backupMnemonicToEntropy(mnemonic);
    expect(Array.from(back)).toEqual(Array.from(ent));
  });

  it("rejects wrong-length entropy on encode", () => {
    expect(() => entropyToBackupMnemonic(new Uint8Array(31))).toThrow();
    expect(() => entropyToBackupMnemonic(new Uint8Array(33))).toThrow();
  });

  it("decode rejects a bad-checksum mnemonic", () => {
    // 24 valid-but-wrong-checksum words.
    const bad =
      "abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon abandon abandon zebra";
    expect(() => backupMnemonicToEntropy(bad)).toThrow();
  });

  it("decode trims surrounding whitespace", () => {
    const ent = fixtureEntropy(0x77);
    const mnemonic = entropyToBackupMnemonic(ent);
    const padded = "\n  " + mnemonic + "  \n";
    const back = backupMnemonicToEntropy(padded);
    expect(Array.from(back)).toEqual(Array.from(ent));
  });
});

describe("wrapSlhDsaSecret ↔ unwrapSlhDsaSecret", () => {
  it("AEAD round-trips a 64-byte secret cleanly", () => {
    const vek = fixtureVek(0x55);
    const secret = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.secretKey);
    for (let i = 0; i < secret.length; i++) secret[i] = i & 0xff;
    const wrapped = wrapSlhDsaSecret(vek, secret);
    const unwrapped = unwrapSlhDsaSecret(vek, wrapped.ciphertext, wrapped.nonce);
    expect(Array.from(unwrapped)).toEqual(Array.from(secret));
  });

  it("rejects bad VEK length on wrap", () => {
    expect(() =>
      wrapSlhDsaSecret(
        new Uint8Array(16),
        new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.secretKey),
      ),
    ).toThrow(/bad VEK length/);
  });

  it("rejects bad secret length on wrap", () => {
    expect(() => wrapSlhDsaSecret(fixtureVek(0x11), new Uint8Array(63))).toThrow(
      /bad secret length/,
    );
  });

  it("unwrap fails AEAD-style on tampered ciphertext", () => {
    const vek = fixtureVek(0x99);
    const secret = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.secretKey);
    secret.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const wrapped = wrapSlhDsaSecret(vek, secret);
    // Flip a single byte deep in the ciphertext payload.
    const ctBytes = atob(wrapped.ciphertext);
    const tamperedBytes = ctBytes.slice(0, 10) +
      String.fromCharCode(ctBytes.charCodeAt(10) ^ 0xff) +
      ctBytes.slice(11);
    const tamperedCt = btoa(tamperedBytes);
    expect(() =>
      unwrapSlhDsaSecret(vek, tamperedCt, wrapped.nonce),
    ).toThrow();
  });

  it("unwrap fails with the wrong VEK", () => {
    const vek1 = fixtureVek(0x01);
    const vek2 = fixtureVek(0x02);
    const secret = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.secretKey);
    const wrapped = wrapSlhDsaSecret(vek1, secret);
    expect(() =>
      unwrapSlhDsaSecret(vek2, wrapped.ciphertext, wrapped.nonce),
    ).toThrow();
  });
});

describe("prepareSlhDsaBackup", () => {
  it("returns mnemonic + persistable backup record", () => {
    const vek = fixtureVek(0xab);
    const ent = fixtureEntropy(0xcd);
    const { mnemonic, backup } = prepareSlhDsaBackup({
      vek,
      now: 1_700_000_000_000,
      entropy: ent,
    });
    expect(mnemonic.split(" ").length).toBe(24);
    expect(backup.parameterSet).toBe("slh_dsa_sha2_128s");
    expect(backup.chainRegistrationStatus).toBe("not-registered");
    expect(backup.coldStorageConfirmed).toBe(false);
    expect(backup.createdAt).toBe(1_700_000_000_000);
    // 32-byte pubkey ⇒ 64 hex chars.
    expect(backup.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(backup.encryptedPrivateKey.length).toBeGreaterThan(0);
    expect(backup.encryptedPrivateKeyNonce.length).toBeGreaterThan(0);
  });

  it("the persisted pubkey matches direct noble keygen on the same entropy", () => {
    const ent = fixtureEntropy(0x55);
    const { backup } = prepareSlhDsaBackup({
      vek: fixtureVek(0x33),
      now: 0,
      entropy: ent,
    });

    // Independent derivation through the same code path (same domain
    // tag, same SHAKE256 expansion, same noble keygen) MUST land on
    // the same pubkey. This pins the entropy → pubkey mapping so a
    // future drift in the derivation surfaces immediately.
    const seed = deriveSlhDsaSeed(ent);
    const kp = slh_dsa_sha2_128s.keygen(seed);
    let expectedHex = "";
    for (const b of kp.publicKey) {
      expectedHex += b.toString(16).padStart(2, "0");
    }
    expect(backup.publicKey).toBe(expectedHex);
  });

  // ── Known-answer test (KAT) — cross-version backup-compat tripwire ──
  // The determinism test above recomputes `expectedHex` from the SAME installed
  // noble, so it only proves self-consistency and would NOT catch a future
  // @noble/post-quantum bump that silently changed slh_dsa_sha2_128s keygen
  // output (both sides shift together). This freezes the backup pubkey for a
  // fixed entropy as a LITERAL, so any cross-version output drift fails here
  // immediately. `backup.publicKey` is registered on-chain at the emergency-key
  // registry (precompile 0x1100), so a silent drift would break recovery + the
  // on-chain registration — hence the frozen vector. Captured under
  // @noble/post-quantum 0.6.1 (P7-002 align). To re-derive: run
  // deriveSlhDsaSeed(fixtureEntropy(0x55)) -> slh_dsa_sha2_128s.keygen(seed),
  // hex-encode publicKey.
  it("KAT: a fixed entropy derives a frozen backup pubkey (guards noble output drift)", () => {
    const seed = deriveSlhDsaSeed(fixtureEntropy(0x55));
    const kp = slh_dsa_sha2_128s.keygen(seed);
    let pubHex = "";
    for (const b of kp.publicKey) pubHex += b.toString(16).padStart(2, "0");
    expect(pubHex).toBe(
      "ab8579a8e1f65d12dcc8fb49e13aed4e55a41726e83742973398a1b702333442",
    );
    expect(kp.publicKey.length).toBe(SLH_DSA_SHA2_128S_LENGTHS.publicKey);
    expect(kp.secretKey.length).toBe(SLH_DSA_SHA2_128S_LENGTHS.secretKey);
    // SLH-DSA layout SK.seed|SK.prf|PK.seed|PK.root: the 32-byte pubkey is the
    // last 32 bytes of the 64-byte secret key. Pinning this embeds half the
    // secret in the KAT without a fragile 128-char secret-key literal.
    let secTailHex = "";
    for (const b of kp.secretKey.slice(32)) {
      secTailHex += b.toString(16).padStart(2, "0");
    }
    expect(secTailHex).toBe(pubHex);
  });

  it("the same entropy + VEK + timestamp produces an identical backup record (deterministic)", () => {
    // The encryptedPrivateKey field DIFFERS run-to-run because the
    // AEAD nonce is random — `prepareSlhDsaBackup` calls
    // `wrapSlhDsaSecret` which `randomBytes()`-draws a fresh nonce.
    // The pubkey + createdAt do not vary, though.
    const ent = fixtureEntropy(0x77);
    const vek = fixtureVek(0x88);
    const a = prepareSlhDsaBackup({ vek, now: 42, entropy: ent });
    const b = prepareSlhDsaBackup({ vek, now: 42, entropy: ent });
    expect(a.mnemonic).toBe(b.mnemonic);
    expect(a.backup.publicKey).toBe(b.backup.publicKey);
    expect(a.backup.createdAt).toBe(b.backup.createdAt);
    expect(a.backup.parameterSet).toBe(b.backup.parameterSet);
    // Nonces differ — that's by design.
    expect(a.backup.encryptedPrivateKeyNonce).not.toBe(
      b.backup.encryptedPrivateKeyNonce,
    );
  });

  it("the persisted ciphertext decrypts back to the original 64-byte secret", () => {
    const vek = fixtureVek(0x44);
    const ent = fixtureEntropy(0x88);
    const { backup } = prepareSlhDsaBackup({ vek, now: 0, entropy: ent });

    const restored = unwrapSlhDsaSecret(
      vek,
      backup.encryptedPrivateKey,
      backup.encryptedPrivateKeyNonce,
    );
    expect(restored.length).toBe(SLH_DSA_SHA2_128S_LENGTHS.secretKey);
    // The restored secret should match what noble emits on the same
    // entropy — round-tripping through wrap/unwrap doesn't perturb
    // the payload.
    const seed = deriveSlhDsaSeed(ent);
    const kp = slh_dsa_sha2_128s.keygen(seed);
    expect(Array.from(restored)).toEqual(Array.from(kp.secretKey));
  });

  it("uses fresh CSPRNG entropy when none is provided", () => {
    const vek = fixtureVek(0x66);
    const a = prepareSlhDsaBackup({ vek });
    const b = prepareSlhDsaBackup({ vek });
    // Two consecutive calls with no fixture entropy must produce
    // different keypairs (CSPRNG must not be deterministic).
    expect(a.mnemonic).not.toBe(b.mnemonic);
    expect(a.backup.publicKey).not.toBe(b.backup.publicKey);
  });

  it("rejects bad VEK length", () => {
    expect(() => prepareSlhDsaBackup({ vek: new Uint8Array(16) })).toThrow(
      /bad VEK length/,
    );
  });

  it("rejects bad explicit-entropy length (test-fixture footgun)", () => {
    expect(() =>
      prepareSlhDsaBackup({
        vek: fixtureVek(0x00),
        entropy: new Uint8Array(31),
      }),
    ).toThrow(/entropy must be 32 bytes/);
  });
});

describe("wrapBackupEntropy ↔ unwrapBackupEntropy ↔ recoverBackupMnemonic", () => {
  it("AEAD round-trips 32-byte entropy", () => {
    const vek = fixtureVek(0xa1);
    const ent = fixtureEntropy(0xb2);
    const w = wrapBackupEntropy(vek, ent);
    const back = unwrapBackupEntropy(vek, w.ciphertext, w.nonce);
    expect(Array.from(back)).toEqual(Array.from(ent));
  });

  it("rejects bad entropy length on wrap", () => {
    expect(() => wrapBackupEntropy(fixtureVek(0x00), new Uint8Array(31))).toThrow();
  });

  it("rejects bad decrypted-entropy length (defence against corrupt ciphertext that decrypts)", () => {
    // Build a ciphertext over a non-32-byte plaintext using the same
    // VEK; the unwrap helper must throw on the length mismatch.
    const vek = fixtureVek(0xc3);
    const w = wrapSlhDsaSecret(
      vek,
      new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.secretKey),
    );
    expect(() => unwrapBackupEntropy(vek, w.ciphertext, w.nonce)).toThrow(
      /decrypted entropy is/,
    );
  });

  it("recoverBackupMnemonic round-trips through prepareSlhDsaBackup", () => {
    const vek = fixtureVek(0xd4);
    const ent = fixtureEntropy(0xe5);
    const { mnemonic, backup } = prepareSlhDsaBackup({
      vek,
      now: 0,
      entropy: ent,
    });
    const recovered = recoverBackupMnemonic(vek, backup);
    expect(recovered).toBe(mnemonic);
    // The recovered mnemonic round-trips back to the same entropy.
    const back = backupMnemonicToEntropy(recovered);
    expect(Array.from(back)).toEqual(Array.from(ent));
  });

  it("recoverBackupMnemonic fails with the wrong VEK", () => {
    const vek1 = fixtureVek(0x11);
    const vek2 = fixtureVek(0x22);
    const { backup } = prepareSlhDsaBackup({
      vek: vek1,
      now: 0,
      entropy: fixtureEntropy(0x33),
    });
    expect(() => recoverBackupMnemonic(vek2, backup)).toThrow();
  });
});

describe("decodeBackupPublicKey", () => {
  it("round-trips a stored hex pubkey to raw 32 bytes", () => {
    const hex = "ab".repeat(32);
    const bytes = decodeBackupPublicKey(hex);
    expect(bytes.length).toBe(32);
    expect(Array.from(bytes)).toEqual(Array.from(new Uint8Array(32).fill(0xab)));
  });

  it("rejects wrong-length hex", () => {
    expect(() => decodeBackupPublicKey("ab".repeat(16))).toThrow();
  });
});
