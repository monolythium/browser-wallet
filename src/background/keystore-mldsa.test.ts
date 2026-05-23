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

function bytesToHexLower(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

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

describe("keystore-mldsa v4-multi state machine (Phase 5 Commit 2)", () => {
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeStub());
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it(
    "unlockContainerV4 migrates the legacy entry on first call and loads the active backend",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "vault-unlock-password";
      const { address: legacyAddress } =
        await ks.createVaultFromNewMnemonic(password);
      expect(storage["mono.vault.v4"]).toBeDefined();
      expect(storage["mono.vaults.v4"]).toBeUndefined();

      // First container unlock — migration runs, MEK is cached, active
      // vault's backend is loaded.
      const r = await ks.unlockContainerV4(password);
      expect(r.address).toBe(legacyAddress);
      expect(typeof r.vaultId).toBe("string");
      expect(storage["mono.vaults.v4"]).toBeDefined();
      expect(storage["mono.vault.v4"]).toBeDefined(); // legacy preserved
      expect(ks.isUnlockedV4()).toBe(true);
      expect(ks.getUnlockedAddressV4()).toBe(legacyAddress);

      // Wrong password rejects.
      ks.lockV4();
      await expect(ks.unlockContainerV4("wrong")).rejects.toThrow();
      expect(ks.isUnlockedV4()).toBe(false);
    },
    60_000,
  );

  it(
    "listVaultsV4 returns null pre-migration and one summary post-migration",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      expect(await ks.listVaultsV4()).toBeNull();

      const password = "list-password";
      const { address } = await ks.createVaultFromNewMnemonic(password);
      // listVaultsV4 still null until migration runs.
      expect(await ks.listVaultsV4()).toBeNull();

      await ks.unlockContainerV4(password);
      const list = await ks.listVaultsV4();
      expect(list).not.toBeNull();
      expect(list!.length).toBe(1);
      expect(list![0]!.addr).toBe(address);
      expect(list![0]!.label).toBe("Vault 1");
      expect(list![0]!.isActive).toBe(true);
    },
    60_000,
  );

  it(
    "addVaultFreshV4 appends a second vault; its mnemonic re-derives to the same address",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "add-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      const before = (await ks.listVaultsV4())!;
      expect(before.length).toBe(1);

      const added = await ks.addVaultFreshV4();
      expect(added.vaultId).not.toBe(before[0]!.id);
      expect(added.mnemonic.split(" ").length).toBe(24);
      expect(added.address).toMatch(/^0x[0-9a-f]{40}$/);

      const after = (await ks.listVaultsV4())!;
      expect(after.length).toBe(2);
      expect(after[1]!.label).toBe("Vault 2");
      expect(after[1]!.addr).toBe(added.address);
      // Active should NOT have switched — add is non-destructive.
      expect(after[0]!.isActive).toBe(true);
      expect(after[1]!.isActive).toBe(false);
    },
    90_000,
  );

  it(
    "addVaultImportV4 rejects a duplicate-address mnemonic",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "import-password";
      const { mnemonic: firstMnemonic } =
        await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      // Importing the same mnemonic that backs Vault 1 → derives the same
      // address → must reject.
      await expect(ks.addVaultImportV4(firstMnemonic)).rejects.toThrow(
        /already exists/i,
      );
      const list = (await ks.listVaultsV4())!;
      expect(list.length).toBe(1);
    },
    90_000,
  );

  it(
    "selectActiveVaultV4 switches active vault; lock clears MEK cache",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "select-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      const added = await ks.addVaultFreshV4();
      const before = (await ks.listVaultsV4())!;
      const firstId = before.find((v) => v.isActive)!.id;

      const sel = await ks.selectActiveVaultV4(added.vaultId);
      expect(sel.address).toBe(added.address);
      expect(ks.getUnlockedAddressV4()).toBe(added.address);

      const after = (await ks.listVaultsV4())!;
      expect(after.find((v) => v.id === added.vaultId)!.isActive).toBe(true);
      expect(after.find((v) => v.id === firstId)!.isActive).toBe(false);

      // Lock clears the MEK cache; subsequent select MUST refuse.
      ks.lockV4();
      await expect(ks.selectActiveVaultV4(firstId)).rejects.toThrow(/locked/i);
      await expect(ks.addVaultFreshV4()).rejects.toThrow(/locked/i);
    },
    120_000,
  );

  it(
    "renameVaultV4 trims; rejects empty + over-32-char labels; no unlock required",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "rename-password";
      await ks.createVaultFromNewMnemonic(password);
      // Migrate without unlocking the unit under test — rename is supposed
      // to work pre-unlock. We need the container on disk, so trigger
      // migration via the internal helper.
      const { migrateLegacyToContainerV4 } = ks.__internalV4Multi;
      const container = await migrateLegacyToContainerV4(password);
      expect(container).not.toBeNull();
      const vaultId = container!.vaults[0]!.id;

      // Lock keeps the MEK out of memory; rename still works.
      ks.lockV4();
      expect(ks.isUnlockedV4()).toBe(false);

      await ks.renameVaultV4(vaultId, "  My Daily  ");
      const list1 = (await ks.listVaultsV4())!;
      expect(list1[0]!.label).toBe("My Daily");

      await expect(ks.renameVaultV4(vaultId, "   ")).rejects.toThrow(
        /non-empty/i,
      );
      await expect(
        ks.renameVaultV4(vaultId, "x".repeat(33)),
      ).rejects.toThrow(/1-32/);
      await expect(
        ks.renameVaultV4("unknown-id", "whatever"),
      ).rejects.toThrow(/unknown vault id/);
    },
    60_000,
  );

  it(
    "selectActiveVaultV4 on the already-active vault is a no-op fast path",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "noop-password";
      await ks.createVaultFromNewMnemonic(password);
      const r = await ks.unlockContainerV4(password);
      const noop = await ks.selectActiveVaultV4(r.vaultId);
      expect(noop.address).toBe(r.address);
      expect(ks.getUnlockedAddressV4()).toBe(r.address);
    },
    60_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 Commit 1 — multisig vault storage round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("keystore-mldsa multisig vault (Phase 8 Commit 1)", () => {
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeStub());
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function fakePubkey(byte: number): string {
    return "0x" + byte.toString(16).padStart(2, "0").repeat(1952);
  }
  function fakeAddress(byte: number): string {
    return "0x" + byte.toString(16).padStart(2, "0").repeat(20);
  }
  function makeSigner(
    overrides: { id: string; address: string; label?: string; pubkey?: string },
  ) {
    return {
      id: overrides.id,
      label: overrides.label ?? `Signer ${overrides.id}`,
      address: overrides.address,
      pubkey: overrides.pubkey ?? fakePubkey(0xab),
      role: "external" as const,
    };
  }

  it(
    "addVaultMultisigV4 creates a multisig vault visible in listVaultsV4 with kind='multisig'",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "ms-create-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      const signers = [
        makeSigner({ id: "s-a", address: fakeAddress(0x01), label: "Alice" }),
        makeSigner({ id: "s-b", address: fakeAddress(0x02), label: "Bob" }),
        makeSigner({ id: "s-c", address: fakeAddress(0x03), label: "Carol" }),
      ];
      const created = await ks.addVaultMultisigV4({
        signers,
        threshold: 2,
        label: "Team treasury",
      });
      expect(created.vaultId).toMatch(/[0-9a-f]/);
      expect(created.mnemonic.split(" ").length).toBe(24);
      expect(created.address).toMatch(/^0x[0-9a-f]{40}$/);

      const list = (await ks.listVaultsV4())!;
      expect(list.length).toBe(2);
      const ms = list.find((v) => v.id === created.vaultId)!;
      expect(ms.kind).toBe("multisig");
      expect(ms.label).toBe("Team treasury");
      expect(ms.signerCount).toBe(3);
      expect(ms.threshold).toBe(2);
      expect(ms.pendingCount).toBe(0);
      expect(ms.addr).toBe(created.address);

      // Sibling vault (the legacy "Vault 1") stays kind='single'.
      const single = list.find((v) => v.id !== created.vaultId)!;
      expect(single.kind).toBe("single");
      expect(single.signerCount).toBe(0);
      expect(single.threshold).toBe(0);
    },
    120_000,
  );

  it(
    "readMultisigMetaV4 + writeMultisigMetaV4 round-trip the meta block",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "ms-meta-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      const signers = [
        makeSigner({ id: "s-a", address: fakeAddress(0x01) }),
        makeSigner({ id: "s-b", address: fakeAddress(0x02) }),
      ];
      const { vaultId } = await ks.addVaultMultisigV4({
        signers,
        threshold: 2,
      });

      const initial = (await ks.readMultisigMetaV4(vaultId))!;
      expect(initial.signers.map((s) => s.id)).toEqual(["s-a", "s-b"]);
      expect(initial.threshold).toBe(2);
      expect(initial.proposals).toEqual([]);
      expect(initial.governance).toEqual([]);

      // Mutate threshold to 1 + add a fake proposal, persist, reload.
      const next = {
        ...initial,
        threshold: 1,
        proposals: [
          {
            id: "p-1",
            proposedBy: "s-a",
            createdAt: 1,
            expiresAt: 1_000_000_000_000,
            vaultAddress: fakeAddress(0xcc),
            action: {
              kind: "send" as const,
              to: fakeAddress(0xee),
              valueWeiHex: "0x1",
              chainIdHex: "0x10F2C",
            },
            approvals: [],
            rejections: [],
            status: "pending" as const,
            txHash: null,
          },
        ],
      };
      await ks.writeMultisigMetaV4(vaultId, next);
      const reloaded = (await ks.readMultisigMetaV4(vaultId))!;
      expect(reloaded.threshold).toBe(1);
      expect(reloaded.proposals.length).toBe(1);
      expect(reloaded.proposals[0]!.id).toBe("p-1");

      // listVaultsV4 surfaces the pending count after the mutation.
      const ms = (await ks.listVaultsV4())!.find((v) => v.id === vaultId)!;
      expect(ms.pendingCount).toBe(1);
      expect(ms.threshold).toBe(1);
    },
    120_000,
  );

  it(
    "readMultisigMetaV4 returns null for single vaults and unknown ids",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "ms-null-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      const list = (await ks.listVaultsV4())!;
      const singleId = list[0]!.id;
      expect(await ks.readMultisigMetaV4(singleId)).toBeNull();
      expect(await ks.readMultisigMetaV4("totally-unknown")).toBeNull();
    },
    60_000,
  );

  it(
    "addVaultMultisigV4 rejects validation failures (bad threshold, duplicate signer, bad pubkey)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "ms-validate-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      // threshold > N
      await expect(
        ks.addVaultMultisigV4({
          signers: [
            makeSigner({ id: "s-a", address: fakeAddress(0x01) }),
            makeSigner({ id: "s-b", address: fakeAddress(0x02) }),
          ],
          threshold: 3,
        }),
      ).rejects.toThrow(/exceed/);

      // Duplicate signer address.
      await expect(
        ks.addVaultMultisigV4({
          signers: [
            makeSigner({ id: "s-a", address: fakeAddress(0x01) }),
            makeSigner({ id: "s-b", address: fakeAddress(0x01) }),
          ],
          threshold: 1,
        }),
      ).rejects.toThrow(/duplicate signer address/);

      // Bad pubkey length.
      await expect(
        ks.addVaultMultisigV4({
          signers: [
            makeSigner({
              id: "s-a",
              address: fakeAddress(0x01),
              pubkey: "0xabcd",
            }),
          ],
          threshold: 1,
        }),
      ).rejects.toThrow(/1952 bytes/);
    },
    120_000,
  );

  it(
    "addVaultMultisigV4 requires the container to be unlocked",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "ms-locked-password";
      await ks.createVaultFromNewMnemonic(password);
      // Do NOT unlock the container.

      await expect(
        ks.addVaultMultisigV4({
          signers: [makeSigner({ id: "s", address: fakeAddress(0x01) })],
          threshold: 1,
        }),
      ).rejects.toThrow(/locked/);
    },
    30_000,
  );

  it(
    "signWithVaultV4 produces a signature verifiable against that vault's pubkey",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const {
        MlDsa65Backend,
        pqm1MnemonicToMlDsa65Seed,
      } = await import("@monolythium/core-sdk/crypto");

      const password = "ms-sign-password";
      const { mnemonic } = await ks.createVaultFromNewMnemonic(password);
      const r = await ks.unlockContainerV4(password);
      const activeVaultId = r.vaultId;

      // Pubkey of the active vault (the one that will be signing).
      const pubkeyHex = await ks.getVaultPubkeyV4(activeVaultId);
      expect(pubkeyHex).toMatch(/^0x[0-9a-f]+$/);
      expect(pubkeyHex.length).toBe(2 + 1952 * 2);

      const digest = new Uint8Array(32);
      for (let i = 0; i < 32; i++) digest[i] = i;

      const sig = await ks.signWithVaultV4(activeVaultId, digest);
      expect(sig.length).toBe(3309);

      // Re-derive the backend from the known mnemonic and verify the
      // signature against its own pubkey. The SDK's MlDsa65Backend
      // wraps @noble/post-quantum's ml_dsa65.verify — this is the
      // same verifier path a future on-chain precompile would use.
      const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
      const backend = MlDsa65Backend.fromSeed(seed);
      // Pubkey from the re-derivation must match what the keystore
      // returns; pins that signWithVaultV4 doesn't accidentally
      // swap vaults under us.
      const expected = "0x" + bytesToHexLower(backend.publicKey());
      expect(expected).toBe(pubkeyHex);
      expect(backend.verify(digest, sig)).toBe(true);

      // Tampered digest → verify fails.
      const tampered = new Uint8Array(32);
      tampered.set(digest);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      expect(backend.verify(tampered, sig)).toBe(false);
    },
    120_000,
  );

  it(
    "signWithVaultV4 requires unlocked container + valid digest length",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "ms-sign-gate-password";
      await ks.createVaultFromNewMnemonic(password);

      // No unlock yet.
      await expect(
        ks.signWithVaultV4("any", new Uint8Array(32)),
      ).rejects.toThrow(/locked/);

      await ks.unlockContainerV4(password);

      // Bad digest length.
      await expect(
        ks.signWithVaultV4("any", new Uint8Array(31)),
      ).rejects.toThrow(/32 bytes/);

      // Unknown vault id.
      await expect(
        ks.signWithVaultV4("not-a-vault", new Uint8Array(32)),
      ).rejects.toThrow(/unknown vault id/);
    },
    60_000,
  );

  it(
    "real ML-DSA-65 signature verifies through verifyProposalApprovals + serialize/deserialize",
    async () => {
      // Cross-signer coordination depends on signature verification
      // working against arbitrary pubkeys; this test wires the
      // signWithVaultV4 path through hashTxProposal and round-trips
      // the result through serialize/deserialize, then verifies the
      // imported signature using the same logic the import IPC uses.
      const ks = await import("./keystore-mldsa.js");
      const {
        hashTxProposal: hashTx,
        serializeProposalForShare,
        deserializeSharedProposal,
        verifyProposalApprovals,
      } = await import("../shared/multisig.js");
      const password = "ms-share-password";
      await ks.createVaultFromNewMnemonic(password);
      const u = await ks.unlockContainerV4(password);
      const pubkey = await ks.getVaultPubkeyV4(u.vaultId);

      const proposal: import("../shared/multisig.js").PendingProposal = {
        id: "p-share",
        proposedBy: "s-self",
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
        vaultAddress: "0x" + "ab".repeat(20),
        action: {
          kind: "send",
          to: "0x" + "cd".repeat(20),
          valueWeiHex: "0x1",
          chainIdHex: "0x10F2C",
        },
        approvals: [],
        rejections: [],
        status: "pending",
        txHash: null,
      };
      const digest = hashTx(proposal);
      const sig = await ks.signWithVaultV4(u.vaultId, digest);
      proposal.approvals.push({
        signerId: "s-self",
        signature: "0x" + bytesToHexLower(sig),
        signedAt: 0,
      });

      // Roster carries the SAME pubkey under the signerId we signed as.
      const signers = [
        {
          id: "s-self",
          label: "Self",
          address: u.address,
          pubkey,
          role: "self" as const,
          vaultId: u.vaultId,
        },
      ];

      const blob = serializeProposalForShare(proposal, "tx");
      const env = deserializeSharedProposal(blob);
      expect(env.kind).toBe("tx");
      expect(env.proposal.id).toBe(proposal.id);
      const verified = verifyProposalApprovals(
        env.proposal as import("../shared/multisig.js").PendingProposal,
        signers,
      );
      expect(verified.validApprovals.has("s-self")).toBe(true);
    },
    120_000,
  );

  it(
    "multisig vault round-trips through chrome.storage; meta survives a fresh module import",
    async () => {
      // Build a multisig vault in one module session, then re-import the
      // module from a clean cache and confirm listVaultsV4 + readMultisigMetaV4
      // surface the same kind/signers/threshold. This pins the on-disk
      // shape: any future schema bump that strips `kind` or `multisig`
      // from the persisted record fails this test loudly.
      const password = "ms-roundtrip-password";
      const signers = [
        makeSigner({ id: "s-a", address: fakeAddress(0x01) }),
        makeSigner({ id: "s-b", address: fakeAddress(0x02) }),
      ];

      {
        const ks = await import("./keystore-mldsa.js");
        await ks.createVaultFromNewMnemonic(password);
        await ks.unlockContainerV4(password);
        await ks.addVaultMultisigV4({ signers, threshold: 2, label: "MS" });
      }

      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      // Storage still holds the container — listVaultsV4 returns it
      // without needing unlock.
      const list = (await ks2.listVaultsV4())!;
      expect(list.length).toBe(2);
      const ms = list.find((v) => v.kind === "multisig")!;
      expect(ms.label).toBe("MS");
      expect(ms.signerCount).toBe(2);
      expect(ms.threshold).toBe(2);

      const meta = (await ks2.readMultisigMetaV4(ms.id))!;
      expect(meta.signers.map((s) => s.id)).toEqual(["s-a", "s-b"]);
      expect(meta.threshold).toBe(2);
      expect(storage["mono.vaults.v4"]).toBeDefined();
    },
    180_000,
  );
});

describe("keystore-mldsa passkey state (Phase 9 Commit 1)", () => {
  beforeEach(() => {
    installChromeStub();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function fakeCred(
    i: number,
    kind: "platform" | "cross-platform" = "platform",
  ) {
    return {
      credentialId: `cred-${i}`,
      name: `Cred ${i}`,
      kind,
      createdAt: 1_000_000 + i,
    };
  }

  it(
    "readPasskeyStateV4 returns an empty state for new vaults",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "pk-empty-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const state = await ks.readPasskeyStateV4(list[0]!.id);
      expect(state.credentials).toEqual([]);
      expect(state.policy.enabled).toBe(false);
    },
    120_000,
  );

  it(
    "addPasskeyCredentialV4 + readPasskeyStateV4 round-trip",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "pk-add-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;

      await ks.addPasskeyCredentialV4(id, fakeCred(1));
      await ks.addPasskeyCredentialV4(id, fakeCred(2, "cross-platform"));
      const state = await ks.readPasskeyStateV4(id);
      expect(state.credentials.map((c) => c.credentialId)).toEqual([
        "cred-1",
        "cred-2",
      ]);
      expect(state.credentials[1]!.kind).toBe("cross-platform");
    },
    120_000,
  );

  it(
    "removePasskeyCredentialV4 disables the policy when the last cred goes",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const { defaultPasskeyPolicy } = await import("../shared/passkey.js");
      const password = "pk-remove-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;

      await ks.addPasskeyCredentialV4(id, fakeCred(1));
      await ks.setPasskeyPolicyV4(id, { ...defaultPasskeyPolicy(), enabled: true });
      const before = await ks.readPasskeyStateV4(id);
      expect(before.policy.enabled).toBe(true);

      await ks.removePasskeyCredentialV4(id, "cred-1");
      const after = await ks.readPasskeyStateV4(id);
      expect(after.credentials).toEqual([]);
      expect(after.policy.enabled).toBe(false);
    },
    120_000,
  );

  it(
    "setPasskeyPolicyV4 rejects an invalid policy without persisting",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const { defaultPasskeyPolicy } = await import("../shared/passkey.js");
      const password = "pk-bad-policy-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;

      // limitWei=0 trips the floor check.
      await expect(
        ks.setPasskeyPolicyV4(id, { ...defaultPasskeyPolicy(), limitWei: 0n }),
      ).rejects.toThrow(/invalid policy/);

      const state = await ks.readPasskeyStateV4(id);
      // Policy stays at the default (disabled) — nothing persisted.
      expect(state.policy).toEqual(defaultPasskeyPolicy());
    },
    120_000,
  );

  it(
    "passkey state survives a fresh module import",
    async () => {
      const ks1 = await import("./keystore-mldsa.js");
      const password = "pk-persist-password";
      await ks1.createVaultFromNewMnemonic(password);
      await ks1.unlockContainerV4(password);
      const list1 = (await ks1.listVaultsV4())!;
      const id = list1[0]!.id;
      await ks1.addPasskeyCredentialV4(id, fakeCred(7));

      // Drop the module cache and re-import; the credential should
      // come back unchanged from chrome.storage.local.
      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      await ks2.unlockContainerV4(password);
      const state = await ks2.readPasskeyStateV4(id);
      expect(state.credentials.length).toBe(1);
      expect(state.credentials[0]!.credentialId).toBe("cred-7");
    },
    180_000,
  );
});

describe("keystore-mldsa passkey BigInt round-trip (Phase 9 hotfix)", () => {
  // The base `installChromeStub` keeps stored objects as live JS
  // references, so BigInt values survive a set / get round-trip in
  // the test environment but DO NOT in real Chrome (some Chrome
  // versions strip BigInt fields silently from chrome.storage.local).
  // These tests pin the hotfix that converts BigInt → decimal-string
  // on write and parses back on read so the bug is captured in CI.

  /** Storage stub that JSON-serialises every value on `set` and
   *  parses on `get` — closest in-process approximation of the real
   *  chrome.storage failure mode we hit on Windows Hello. */
  function installJsonStorageStub(): { storage: StorageMap } {
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
              if (k in storage) {
                const raw = storage[k];
                if (typeof raw === "string") {
                  try {
                    out[k] = JSON.parse(raw);
                  } catch {
                    out[k] = raw;
                  }
                } else {
                  out[k] = raw;
                }
              }
            }
            queueMicrotask(() => cb(out));
          },
          set: (entries: Record<string, unknown>, cb: () => void) => {
            for (const [k, v] of Object.entries(entries)) {
              // Mimic the real chrome.storage write path. If `v`
              // contains BigInt values that aren't serialised first,
              // this would throw — which is exactly the bug we are
              // pinning against. The hotfix converts to strings BEFORE
              // calling set, so this branch never sees a BigInt.
              storage[k] = JSON.stringify(v);
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

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function fakeCred(i: number) {
    return {
      credentialId: `cred-${i}`,
      name: `Cred ${i}`,
      kind: "platform" as const,
      createdAt: 1_000_000 + i,
    };
  }

  it(
    "BigInt policy survives a JSON-serialising storage round-trip (real Chrome)",
    async () => {
      installJsonStorageStub();
      const ks = await import("./keystore-mldsa.js");
      const { DEFAULT_PASSKEY_LIMIT_LYTHOSHI } =
        await import("../shared/passkey.js");
      const password = "pk-bigint-roundtrip-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;

      // This is the operation that crashed on Windows Hello before
      // the hotfix — the policy contains BigInt fields by default,
      // and the storage stub here serialises them through JSON
      // (which would historically have thrown / stripped the field).
      const after = await ks.addPasskeyCredentialV4(id, fakeCred(1));
      expect(after.credentials.length).toBe(1);
      // The policy bigints came back through the round-trip intact.
      expect(typeof after.policy.limitWei).toBe("bigint");
      expect(typeof after.policy.dailyCapWei).toBe("bigint");
      expect(after.policy.limitWei).toBe(DEFAULT_PASSKEY_LIMIT_LYTHOSHI);

      // Drop the module + re-import; the SAME bigint values come
      // back after a fresh load from the JSON-stringified storage.
      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      await ks2.unlockContainerV4(password);
      const reread = await ks2.readPasskeyStateV4(id);
      expect(reread.credentials[0]!.credentialId).toBe("cred-1");
      expect(typeof reread.policy.limitWei).toBe("bigint");
      expect(reread.policy.limitWei).toBe(DEFAULT_PASSKEY_LIMIT_LYTHOSHI);
    },
    180_000,
  );

  it(
    "stored legacy wei passkey policy normalizes to lythoshi",
    async () => {
      installJsonStorageStub();
      const ks = await import("./keystore-mldsa.js");
      const {
        DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
        DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
      } = await import("../shared/passkey.js");
      const password = "pk-legacy-wei-policy-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;

      await ks.addPasskeyCredentialV4(id, fakeCred(1));

      const got = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(["mono.vaults.v4"], (g) => resolve(g));
      });
      const parsed = got["mono.vaults.v4"] as {
        vaults: { passkey?: { policy: Record<string, unknown> } }[];
      };
      parsed.vaults[0]!.passkey!.policy.limitWei =
        "100000000000000000000";
      parsed.vaults[0]!.passkey!.policy.dailyCapWei =
        "500000000000000000000";
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(
          { "mono.vaults.v4": parsed },
          () => resolve(),
        );
      });

      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      await ks2.unlockContainerV4(password);
      const state = await ks2.readPasskeyStateV4(id);
      expect(state.policy.limitWei).toBe(DEFAULT_PASSKEY_LIMIT_LYTHOSHI);
      expect(state.policy.dailyCapWei).toBe(
        DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
      );
    },
    180_000,
  );

  it(
    "stored policy with missing BigInt fields falls back to defaults",
    async () => {
      installJsonStorageStub();
      const ks = await import("./keystore-mldsa.js");
      const {
        DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
        DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
      } = await import("../shared/passkey.js");
      const password = "pk-corrupt-policy-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;

      // Register a credential normally so the vault has a passkey
      // record on disk.
      await ks.addPasskeyCredentialV4(id, fakeCred(1));

      // Simulate the real-Chrome corruption: corrupt the stored
      // container so policy.limitWei / dailyCapWei are missing
      // entirely (some Chrome versions silently strip BigInt fields
      // on set). Hand-edit the JSON-serialised storage directly.
      // Array-form key — the stub iterates `keys` with `for-of` and
      // would walk a bare string character-by-character.
      const got = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(["mono.vaults.v4"], (g) => resolve(g));
      });
      const parsed = got["mono.vaults.v4"] as {
        vaults: { passkey?: { policy: Record<string, unknown> } }[];
      };
      // Strip the bigint fields from the persisted policy to mimic
      // the production failure mode.
      delete parsed.vaults[0]!.passkey!.policy.limitWei;
      delete parsed.vaults[0]!.passkey!.policy.dailyCapWei;
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(
          { "mono.vaults.v4": parsed },
          () => resolve(),
        );
      });

      // Fresh import — the load path normalises through
      // clonePasskeyState, filling in defaults for missing fields.
      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      await ks2.unlockContainerV4(password);
      const state = await ks2.readPasskeyStateV4(id);
      // Credential survives.
      expect(state.credentials.length).toBe(1);
      // Missing policy fields healed to defaults — and crucially
      // they are bigints, so any downstream `.toString()` works.
      expect(state.policy.limitWei).toBe(DEFAULT_PASSKEY_LIMIT_LYTHOSHI);
      expect(state.policy.dailyCapWei).toBe(
        DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
      );
    },
    180_000,
  );

  it(
    "registration with a fully-missing on-disk passkey policy still succeeds",
    async () => {
      installJsonStorageStub();
      const ks = await import("./keystore-mldsa.js");
      const password = "pk-no-policy-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;

      // Hand-write a vault record with `passkey: { credentials: [...], policy: {} }`
      // — i.e. policy object exists but every field has been
      // stripped. This is the worst-case shape we'd see after a
      // production BigInt-strip incident. Array-form key per the
      // stub contract.
      const got = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(["mono.vaults.v4"], (g) => resolve(g));
      });
      const container = got["mono.vaults.v4"] as {
        vaults: { id: string; passkey?: unknown }[];
      };
      container.vaults[0]!.passkey = {
        credentials: [],
        policy: {},
      };
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(
          { "mono.vaults.v4": container },
          () => resolve(),
        );
      });

      // Now attempt a registration — this is the actual
      // Windows-Hello-on-fresh-Phase-9-install failure scenario.
      // Before the hotfix this returned the dreaded
      // "Cannot read properties of undefined (reading 'toString')"
      // because the in-memory policy retained the `{}` shape with
      // no bigint fields.
      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      await ks2.unlockContainerV4(password);
      const after = await ks2.addPasskeyCredentialV4(id, fakeCred(7));
      expect(after.credentials[0]!.credentialId).toBe("cred-7");
      expect(typeof after.policy.limitWei).toBe("bigint");
    },
    180_000,
  );
});

describe("keystore-mldsa SLH-DSA backup CRUD (Phase 10 Commit 1)", () => {
  beforeEach(() => {
    installChromeStub();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function fakeBackup(
    overrides: Partial<{
      publicKey: string;
      chainRegistrationStatus:
        | "not-registered"
        | "pending"
        | "registered"
        | "registration-failed";
      coldStorageConfirmed: boolean;
      createdAt: number;
    }> = {},
  ) {
    return {
      encryptedPrivateKey: "ZmFrZS1lbmNyeXB0ZWQ=",
      encryptedPrivateKeyNonce:
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
      encryptedEntropy: "ZW50cm9weS1lbmNyeXB0ZWQ=",
      encryptedEntropyNonce:
        "GBkaGxwdHh8gISIjJCUmJygpKisscy0u",
      publicKey: overrides.publicKey ?? "ab".repeat(32),
      parameterSet: "slh_dsa_sha2_128s" as const,
      chainRegistrationStatus:
        overrides.chainRegistrationStatus ?? ("not-registered" as const),
      coldStorageConfirmed: overrides.coldStorageConfirmed ?? false,
      createdAt: overrides.createdAt ?? 1_700_000_000_000,
    };
  }

  it(
    "readSlhDsaBackupV4 returns null for vaults without a backup",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "slh-empty-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const result = await ks.readSlhDsaBackupV4(list[0]!.id);
      expect(result).toBeNull();
    },
    120_000,
  );

  it(
    "writeSlhDsaBackupV4 + readSlhDsaBackupV4 round-trip cleanly",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "slh-rw-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;
      const persisted = await ks.writeSlhDsaBackupV4(id, fakeBackup());
      expect(persisted.publicKey).toBe("ab".repeat(32));
      const reread = await ks.readSlhDsaBackupV4(id);
      expect(reread).not.toBeNull();
      expect(reread!.publicKey).toBe("ab".repeat(32));
      expect(reread!.parameterSet).toBe("slh_dsa_sha2_128s");
      expect(reread!.chainRegistrationStatus).toBe("not-registered");
    },
    120_000,
  );

  it(
    "writeSlhDsaBackupV4 overwrites previous record atomically (status transitions)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "slh-overwrite-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;
      await ks.writeSlhDsaBackupV4(id, fakeBackup());
      await ks.writeSlhDsaBackupV4(
        id,
        fakeBackup({
          chainRegistrationStatus: "pending",
          coldStorageConfirmed: true,
        }),
      );
      const after = await ks.readSlhDsaBackupV4(id);
      expect(after?.chainRegistrationStatus).toBe("pending");
      expect(after?.coldStorageConfirmed).toBe(true);
    },
    120_000,
  );

  it(
    "clearSlhDsaBackupV4 drops the record (re-export escape hatch)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "slh-clear-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;
      await ks.writeSlhDsaBackupV4(id, fakeBackup());
      const dropped = await ks.clearSlhDsaBackupV4(id);
      expect(dropped).toBe(true);
      const after = await ks.readSlhDsaBackupV4(id);
      expect(after).toBeNull();
      // Second clear is a no-op (returns false, doesn't throw).
      const dropped2 = await ks.clearSlhDsaBackupV4(id);
      expect(dropped2).toBe(false);
    },
    120_000,
  );

  it(
    "backup record survives a fresh module import (chrome.storage round-trip)",
    async () => {
      const ks1 = await import("./keystore-mldsa.js");
      const password = "slh-persist-password";
      await ks1.createVaultFromNewMnemonic(password);
      await ks1.unlockContainerV4(password);
      const list1 = (await ks1.listVaultsV4())!;
      const id = list1[0]!.id;
      await ks1.writeSlhDsaBackupV4(
        id,
        fakeBackup({
          chainRegistrationStatus: "registered",
          coldStorageConfirmed: true,
        }),
      );

      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      await ks2.unlockContainerV4(password);
      const reread = await ks2.readSlhDsaBackupV4(id);
      expect(reread).not.toBeNull();
      expect(reread!.publicKey).toBe("ab".repeat(32));
      expect(reread!.chainRegistrationStatus).toBe("registered");
      expect(reread!.coldStorageConfirmed).toBe(true);
    },
    180_000,
  );

  it(
    "corrupt on-disk backup record self-heals (read returns null, no crash)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "slh-corrupt-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const list = (await ks.listVaultsV4())!;
      const id = list[0]!.id;
      await ks.writeSlhDsaBackupV4(id, fakeBackup());

      // Corrupt the on-disk shape directly — non-hex pubkey
      // characters. The next read should silently drop the field
      // rather than wedge the IPC.
      const got = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(["mono.vaults.v4"], (g) => resolve(g));
      });
      const container = got["mono.vaults.v4"] as {
        vaults: { passkey?: unknown; slhDsaBackup?: { publicKey?: string } }[];
      };
      container.vaults[0]!.slhDsaBackup!.publicKey = "z".repeat(64);
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(
          { "mono.vaults.v4": container },
          () => resolve(),
        );
      });

      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      await ks2.unlockContainerV4(password);
      const reread = await ks2.readSlhDsaBackupV4(id);
      expect(reread).toBeNull();
    },
    180_000,
  );
});
