// Keystore round-trip + wrong-password + v1-rejection coverage.
//
// The keystore module reads/writes through `chrome.storage.local`. We stub
// the chrome global with an in-memory record so vitest can round-trip the
// real encryption/decryption code paths under Node — no fake-crypto, no
// fake-storage. Argon2id m=64 MiB / t=3 takes ~1 s here, hence the longer
// per-test timeout.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StorageMap {
  [k: string]: unknown;
}

function installChromeStub(): { storage: StorageMap } {
  const storage: StorageMap = {};
  // Mimic the small slice of chrome.storage.local.{get,set,remove} the
  // keystore touches. Chrome callbacks are sync-ish in MV3 — we resolve
  // immediately (next microtask) to keep ordering deterministic.
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (
          keys: string[],
          cb: (res: Record<string, unknown>) => void,
        ) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in storage) out[k] = storage[k];
          }
          queueMicrotask(() => cb(out));
        },
        set: (entries: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(entries)) {
            storage[k] = v;
          }
          queueMicrotask(() => cb());
        },
        remove: (keys: string[], cb?: () => void) => {
          for (const k of keys) delete storage[k];
          if (cb) queueMicrotask(() => cb());
        },
      },
    },
  };
  return { storage };
}

describe("keystore v2 (argon2id + xchacha20-poly1305)", () => {
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeStub());
    // Re-import the module per test so the in-memory `unlocked` state from
    // a previous test doesn't leak. `vi.resetModules()` clears vitest's
    // module cache; subsequent dynamic `import()`s return fresh instances.
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it(
    "round-trips a fresh vault: create → lock → unlock → sign",
    async () => {
      const ks = await import("./keystore.js");
      const { mnemonic, address } = await ks.createVaultFromNewMnemonic(
        "correct-horse-battery",
      );
      expect(mnemonic.split(" ").length).toBe(12);
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);

      // The on-disk envelope must be the v2 shape.
      const stored = storage["mono.vault"] as Record<string, unknown>;
      expect(stored).toMatchObject({
        version: 2,
        kdf: "argon2id",
        aead: "xchacha20-poly1305",
      });
      expect(ks.__internal.isV2Envelope(stored)).toBe(true);
      expect(ks.__internal.isV1Envelope(stored)).toBe(false);

      // Lock zeroes the in-memory key.
      ks.lock();
      expect(ks.isUnlocked()).toBe(false);

      // Re-unlocking with the right password recovers the same address.
      const r = await ks.unlock("correct-horse-battery");
      expect(r.address).toBe(address);
      expect(ks.isUnlocked()).toBe(true);

      // personal_sign returns a 65-byte sig; we don't pin the bytes
      // because secp256k1 is non-deterministic, but the shape must match.
      const sig = await ks.personalSign("hello world");
      expect(sig.length).toBe(65);
      expect(sig[64]).toBeGreaterThanOrEqual(27);
      expect(sig[64]).toBeLessThanOrEqual(28);
    },
    180_000,
  );

  it(
    "rejects the wrong password",
    async () => {
      const ks = await import("./keystore.js");
      await ks.createVaultFromNewMnemonic("correct-horse-battery");
      ks.lock();

      await expect(ks.unlock("wrong-password")).rejects.toThrow(/wrong password/i);
      expect(ks.isUnlocked()).toBe(false);
    },
    180_000,
  );

  it(
    "rejects a v1 (PBKDF2+AES-GCM) envelope on unlock with a clear upgrade message",
    async () => {
      const ks = await import("./keystore.js");
      // Inject a v1-shaped envelope directly into chrome.storage.local.
      // We don't need the ciphertext to be decryptable — `loadVault` rejects
      // before any key derivation happens.
      storage["mono.vault"] = {
        v: 1,
        kdf: "pbkdf2-sha256",
        iter: 250_000,
        salt: "QUFBQUFBQUFBQUFBQUFBQQ==",
        nonce: "QUFBQUFBQUFBQUFB",
        ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        addr: "0x0000000000000000000000000000000000000000",
      };

      // hasVault() treats v1 as "no vault" so the popup routes to onboarding.
      expect(await ks.hasVault()).toBe(false);
      // hasLegacyVault() exposes the truth so the popup can show the notice.
      expect(await ks.hasLegacyVault()).toBe(true);

      await expect(ks.unlock("anything")).rejects.toThrow(/vault format upgraded/i);
      // The error class is exported so the popup IPC layer could narrow on it
      // if it ever wanted to distinguish v1 from "wrong password".
      await expect(ks.unlock("anything")).rejects.toBeInstanceOf(ks.LegacyVaultError);
    },
    10_000,
  );

  it("v2 envelope detector rejects malformed shapes", async () => {
    const ks = await import("./keystore.js");
    expect(ks.__internal.isV2Envelope(null)).toBe(false);
    expect(ks.__internal.isV2Envelope({})).toBe(false);
    expect(
      ks.__internal.isV2Envelope({
        version: 2,
        kdf: "argon2id",
        aead: "xchacha20-poly1305",
        kdfParams: { m: 1024, t: 1, p: 1 }, // missing salt
        nonce: "AAAA",
        ciphertext: "AAAA",
        addr: "0x0",
      }),
    ).toBe(false);
    expect(
      ks.__internal.isV2Envelope({
        version: 1, // wrong version
        kdf: "argon2id",
        aead: "xchacha20-poly1305",
        kdfParams: { m: 1024, t: 1, p: 1, salt: "AA" },
        nonce: "AA",
        ciphertext: "AA",
        addr: "0x0",
      }),
    ).toBe(false);
  });
});
