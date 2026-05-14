// keystore-mldsa Phase 5 multi-vault layer tests.
//
// Covers the additive surface from Phase 5 Commit 1:
//   - VEK wrap/unwrap round-trip under a MEK
//   - sealVaultEnvelopeV4 / openVaultEnvelopeV4 round-trip
//   - Legacy mono.vault.v4 → mono.vaults.v4 migration round-trip
//   - Migration idempotence (second call no-ops)
//   - Multi-vault unlock under a single MEK
//   - Container key (mono.vaults.v4) and legacy key (mono.vault.v4)
//     are independent — populating one does not affect the other
//
// The chrome.storage.local stub mirrors keystore.test.ts. Argon2id
// dominates the per-test runtime (~1-2 s on a 2020-era laptop), so
// every test carries a generous timeout.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StorageMap {
  [k: string]: unknown;
}

function installChromeStub(): { storage: StorageMap } {
  const storage: StorageMap = {};
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
        remove: (keys: string[] | string, cb?: () => void) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete storage[k];
          if (cb) queueMicrotask(() => cb());
        },
      },
    },
  };
  return { storage };
}

describe("keystore-mldsa v4-multi (Phase 5 Commit 1)", () => {
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeStub());
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it(
    "MEK derivation + VEK wrap/unwrap round-trips",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const {
        generateMasterKdfParamsV4,
        deriveMekV4,
        generateVekV4,
        wrapVekV4,
        unwrapVekV4,
      } = ks.__internalV4Multi;

      const params = generateMasterKdfParamsV4();
      expect(params.kdf).toBe("argon2id");
      expect(params.m).toBeGreaterThan(0);
      expect(typeof params.salt).toBe("string");

      const mek = await deriveMekV4("master-password", params);
      expect(mek.length).toBe(32);

      const vek = generateVekV4();
      expect(vek.length).toBe(32);

      const wrapped = wrapVekV4(mek, vek);
      expect(wrapped.aead).toBe("xchacha20-poly1305");

      const unwrapped = unwrapVekV4(mek, wrapped);
      expect(unwrapped.length).toBe(32);
      expect(Array.from(unwrapped)).toEqual(Array.from(vek));
    },
    30_000,
  );

  it(
    "unwrap with wrong MEK throws (fail-closed)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const {
        generateMasterKdfParamsV4,
        deriveMekV4,
        generateVekV4,
        wrapVekV4,
        unwrapVekV4,
      } = ks.__internalV4Multi;

      const params = generateMasterKdfParamsV4();
      const goodMek = await deriveMekV4("right-password", params);
      const badMek = await deriveMekV4("wrong-password", params);
      const vek = generateVekV4();
      const wrapped = wrapVekV4(goodMek, vek);

      expect(() => unwrapVekV4(badMek, wrapped)).toThrow();
    },
    30_000,
  );

  it(
    "sealVaultEnvelopeV4 + openVaultEnvelopeV4 round-trip seed + mnemonic",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const { generateVekV4, sealVaultEnvelopeV4, openVaultEnvelopeV4 } =
        ks.__internalV4Multi;

      const vek = generateVekV4();
      const seed = new Uint8Array(32);
      for (let i = 0; i < 32; i++) seed[i] = i + 1;
      const mnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

      const env = sealVaultEnvelopeV4(vek, seed, mnemonic);
      expect(typeof env.seedNonce).toBe("string");
      expect(typeof env.seedCiphertext).toBe("string");
      expect(typeof env.mnemonicNonce).toBe("string");
      expect(typeof env.mnemonicCiphertext).toBe("string");

      const opened = openVaultEnvelopeV4(vek, env);
      expect(opened.seed.length).toBe(32);
      expect(Array.from(opened.seed)).toEqual(Array.from(seed));
      expect(opened.mnemonic).toBe(mnemonic);
    },
    10_000,
  );

  it(
    "migrates legacy mono.vault.v4 to mono.vaults.v4 container; same seed + mnemonic recoverable",
    async () => {
      const ks = await import("./keystore-mldsa.js");

      // Create a legacy single-vault entry by going through the
      // existing v4 onboarding path. The legacy entry now lives at
      // mono.vault.v4 in our stub storage.
      const password = "migration-password";
      const { mnemonic: legacyMnemonic, address: legacyAddress } =
        await ks.createVaultFromNewMnemonic(password);
      expect(storage["mono.vault.v4"]).toBeDefined();
      expect(storage["mono.vaults.v4"]).toBeUndefined();

      const {
        migrateLegacyToContainerV4,
        openVaultEnvelopeV4,
        unwrapVekV4,
        deriveMekV4,
      } = ks.__internalV4Multi;

      const container = await migrateLegacyToContainerV4(password);
      expect(container).not.toBeNull();
      const c = container!;
      expect(c.vaults.length).toBe(1);
      expect(c.activeVaultId).toBe(c.vaults[0]!.id);
      expect(c.vaults[0]!.label).toBe("Vault 1");
      expect(c.vaults[0]!.addr).toBe(legacyAddress);
      // Legacy entry preserved (rollback safety).
      expect(storage["mono.vault.v4"]).toBeDefined();
      // Container persisted.
      expect(storage["mono.vaults.v4"]).toBeDefined();

      // Re-derive MEK, unwrap VEK, open envelope → mnemonic matches.
      const mek = await deriveMekV4(password, c.masterKdf);
      const vek = unwrapVekV4(mek, c.vaults[0]!.wrappedKey);
      const opened = openVaultEnvelopeV4(vek, c.vaults[0]!.envelope);
      expect(opened.mnemonic).toBe(legacyMnemonic);
      expect(opened.seed.length).toBe(32);
    },
    60_000,
  );

  it(
    "migration is idempotent: second call returns null (container already exists)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "idempotence-password";
      await ks.createVaultFromNewMnemonic(password);

      const { migrateLegacyToContainerV4 } = ks.__internalV4Multi;
      const first = await migrateLegacyToContainerV4(password);
      expect(first).not.toBeNull();
      const second = await migrateLegacyToContainerV4(password);
      expect(second).toBeNull();
    },
    60_000,
  );

  it(
    "migration with wrong password throws 'wrong password'",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      await ks.createVaultFromNewMnemonic("right-password");
      const { migrateLegacyToContainerV4 } = ks.__internalV4Multi;
      await expect(
        migrateLegacyToContainerV4("wrong-password"),
      ).rejects.toThrow(/wrong password/i);
      // Container was NOT created on failure.
      expect(storage["mono.vaults.v4"]).toBeUndefined();
    },
    60_000,
  );

  it(
    "two vaults in one container unlock under the same MEK with distinct VEKs",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "multi-vault-password";

      // Build a two-vault container directly via the helpers (the
      // user-facing add-vault flow lands in Phase 5 Commit 2/4; this
      // test exercises the schema itself).
      const {
        generateMasterKdfParamsV4,
        deriveMekV4,
        generateVekV4,
        wrapVekV4,
        unwrapVekV4,
        sealVaultEnvelopeV4,
        openVaultEnvelopeV4,
        saveVaultsContainerV4,
        loadVaultsContainerV4,
      } = ks.__internalV4Multi;

      const masterKdf = generateMasterKdfParamsV4();
      const mek = await deriveMekV4(password, masterKdf);

      const vekA = generateVekV4();
      const vekB = generateVekV4();
      // Sanity: two random VEKs differ.
      expect(Array.from(vekA)).not.toEqual(Array.from(vekB));

      const seedA = new Uint8Array(32).fill(0xaa);
      const seedB = new Uint8Array(32).fill(0xbb);
      const mnemonicA = "vault a " + "abandon ".repeat(22).trim();
      const mnemonicB = "vault b " + "abandon ".repeat(22).trim();

      const recordA = {
        id: crypto.randomUUID(),
        label: "Vault A",
        createdAt: Date.now(),
        wrappedKey: wrapVekV4(mek, vekA),
        envelope: sealVaultEnvelopeV4(vekA, seedA, mnemonicA),
        addr: "0x" + "a".repeat(40),
      };
      const recordB = {
        id: crypto.randomUUID(),
        label: "Vault B",
        createdAt: Date.now() + 1,
        wrappedKey: wrapVekV4(mek, vekB),
        envelope: sealVaultEnvelopeV4(vekB, seedB, mnemonicB),
        addr: "0x" + "b".repeat(40),
      };
      const container = {
        version: 4 as const,
        algo: "ml-dsa-65" as const,
        kdf: "argon2id" as const,
        aead: "xchacha20-poly1305" as const,
        masterKdf,
        vaults: [recordA, recordB],
        activeVaultId: recordA.id,
      };
      await saveVaultsContainerV4(container);

      // Re-derive MEK from the password and unlock both vaults.
      const reloaded = await loadVaultsContainerV4();
      expect(reloaded).not.toBeNull();
      const mek2 = await deriveMekV4(password, reloaded!.masterKdf);
      const unwrappedA = unwrapVekV4(mek2, reloaded!.vaults[0]!.wrappedKey);
      const unwrappedB = unwrapVekV4(mek2, reloaded!.vaults[1]!.wrappedKey);
      expect(Array.from(unwrappedA)).toEqual(Array.from(vekA));
      expect(Array.from(unwrappedB)).toEqual(Array.from(vekB));

      const openedA = openVaultEnvelopeV4(
        unwrappedA,
        reloaded!.vaults[0]!.envelope,
      );
      const openedB = openVaultEnvelopeV4(
        unwrappedB,
        reloaded!.vaults[1]!.envelope,
      );
      expect(openedA.mnemonic).toBe(mnemonicA);
      expect(openedB.mnemonic).toBe(mnemonicB);
      expect(Array.from(openedA.seed)).toEqual(Array.from(seedA));
      expect(Array.from(openedB.seed)).toEqual(Array.from(seedB));
    },
    60_000,
  );

  it(
    "container key and legacy key are independent",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      // Fresh install: no legacy, no container.
      const { loadVaultsContainerV4, migrateLegacyToContainerV4 } =
        ks.__internalV4Multi;
      expect(await ks.hasVaultV4()).toBe(false);
      expect(await loadVaultsContainerV4()).toBeNull();
      // Migration on a fresh install is a no-op.
      const noop = await migrateLegacyToContainerV4("any-password");
      expect(noop).toBeNull();
      expect(storage["mono.vault.v4"]).toBeUndefined();
      expect(storage["mono.vaults.v4"]).toBeUndefined();
    },
    10_000,
  );
});
