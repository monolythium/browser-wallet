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
