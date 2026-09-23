// keystore-mldsa multi-vault layer tests.
//
// Covers the additive multi-vault surface:
//   - VEK wrap/unwrap round-trip under a MEK
//   - sealVaultEnvelopeV4 / openVaultEnvelopeV4 round-trip
//   - createVaultFromNewMnemonic commits straight into the container
//     (mono.vaults.v4); the legacy single-vault key (mono.vault.v4) is
//     never written, and there is no legacy->container migration at HEAD
//   - Multi-vault unlock under a single MEK; multisig + passkey state
//
// The chrome.storage.local stub mirrors keystore.test.ts. Argon2id
// dominates the per-test runtime (~1-2 s on a 2020-era laptop), so
// every test carries a generous timeout.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("keystore-mldsa v4-multi", () => {
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

      const wrapped = wrapVekV4(mek, vek, "v-rt");
      expect(wrapped.aead).toBe("xchacha20-poly1305");

      const unwrapped = unwrapVekV4(mek, wrapped, "v-rt");
      expect(unwrapped.length).toBe(32);
      expect(Array.from(unwrapped)).toEqual(Array.from(vek));
    },
    30_000,
  );

  it("isVaultsContainerV4 refuses out-of-band masterKdf params (P1-002)", async () => {
    const ks = await import("./keystore-mldsa.js");
    const { isVaultsContainerV4, generateMasterKdfParamsV4 } = ks.__internalV4Multi;
    const baseKdf = generateMasterKdfParamsV4(); // valid create-default (64 MiB/t3/p1)
    const container = (kdf: Record<string, unknown>) => ({
      version: 5,
      algo: "ml-dsa-65",
      kdf: "argon2id",
      aead: "xchacha20-poly1305",
      masterKdf: { ...baseKdf, ...kdf },
      vaults: [],
      activeVaultId: "v-1",
    });
    // The in-band create-default reads fine.
    expect(isVaultsContainerV4(container({}))).toBe(true);
    // m out of band — the > cap closes the OOM-on-unlock DoS; the < floor a weak KDF.
    expect(isVaultsContainerV4(container({ m: 1024 }))).toBe(false);
    expect(isVaultsContainerV4(container({ m: 2_000_000 }))).toBe(false);
    // t out of band.
    expect(isVaultsContainerV4(container({ t: 1 }))).toBe(false);
    expect(isVaultsContainerV4(container({ t: 11 }))).toBe(false);
    // p out of band.
    expect(isVaultsContainerV4(container({ p: 0 }))).toBe(false);
    expect(isVaultsContainerV4(container({ p: 5 }))).toBe(false);
  });

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
      const wrapped = wrapVekV4(goodMek, vek, "v-wm");

      expect(() => unwrapVekV4(badMek, wrapped, "v-wm")).toThrow();
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

      const env = sealVaultEnvelopeV4(vek, seed, mnemonic, "v-env");
      expect(typeof env.seedNonce).toBe("string");
      expect(typeof env.seedCiphertext).toBe("string");
      expect(typeof env.mnemonicNonce).toBe("string");
      expect(typeof env.mnemonicCiphertext).toBe("string");

      const opened = openVaultEnvelopeV4(vek, env, "v-env");
      expect(opened.seed.length).toBe(32);
      expect(Array.from(opened.seed)).toEqual(Array.from(seed));
      expect(opened.mnemonic).toBe(mnemonic);
    },
    10_000,
  );

  it(
    "createVaultFromNewMnemonic commits straight into the mono.vaults.v4 container; seed + mnemonic recoverable",
    async () => {
      const ks = await import("./keystore-mldsa.js");

      const password = "create-container-password";
      const { mnemonic, address } =
        await ks.createVaultFromNewMnemonic(password);
      // Phase A: create writes the CONTAINER, not the legacy single-vault key.
      expect(storage["mono.vaults.v4"]).toBeDefined();
      expect(storage["mono.vault.v4"]).toBeUndefined();

      const {
        openVaultEnvelopeV4,
        unwrapVekV4,
        deriveMekV4,
        loadVaultsContainerV4,
      } = ks.__internalV4Multi;
      const c = (await loadVaultsContainerV4())!;
      expect(c.vaults.length).toBe(1);
      expect(c.activeVaultId).toBe(c.vaults[0]!.id);
      expect(c.vaults[0]!.label).toBe("Wallet 1");
      expect(c.vaults[0]!.addr).toBe(address);

      // Re-derive MEK, unwrap VEK, open envelope → mnemonic matches.
      const mek = await deriveMekV4(password, c.masterKdf);
      const vek = unwrapVekV4(mek, c.vaults[0]!.wrappedKey, c.vaults[0]!.id);
      const opened = openVaultEnvelopeV4(
        vek,
        c.vaults[0]!.envelope,
        c.vaults[0]!.id,
      );
      expect(opened.mnemonic).toBe(mnemonic);
      expect(opened.seed.length).toBe(32);
    },
    60_000,
  );

  it(
    "createVaultFromNewMnemonic refuses to overwrite an existing container",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "no-overwrite-password";
      await ks.createVaultFromNewMnemonic(password);
      await expect(
        ks.createVaultFromNewMnemonic(password),
      ).rejects.toThrow(/already exists/i);
    },
    60_000,
  );

  it(
    "createVaultFromMnemonic zeroizes the 32-byte seed when the commit throws (B.1)",
    async () => {
      // The seed must be wiped on the THROW path too (the `finally`), not only
      // on success. Capture the derived seed and force the commit to throw
      // BEFORE argon2 (MlDsa65Backend.fromSeed), then assert the buffer is 0.
      let captured: Uint8Array | null = null;
      vi.doMock("@monolythium/core-sdk/crypto", async () => {
        const actual = await vi.importActual<
          typeof import("@monolythium/core-sdk/crypto")
        >("@monolythium/core-sdk/crypto");
        return {
          ...actual,
          mnemonicToMlDsa65Seed: (m: string) => {
            const s = actual.mnemonicToMlDsa65Seed(m);
            captured = s;
            return s;
          },
          MlDsa65Backend: {
            fromSeed: () => {
              throw new Error("forced commit failure");
            },
          },
        };
      });
      try {
        const ks = await import("./keystore-mldsa.js");
        const mnemonic =
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
        await expect(
          ks.createVaultFromMnemonic("pw-throw-path", mnemonic),
        ).rejects.toThrow(/forced commit failure/);
        expect(captured).not.toBeNull();
        expect(captured!.length).toBe(32);
        expect(Array.from(captured!)).toEqual(new Array(32).fill(0));
      } finally {
        vi.doUnmock("@monolythium/core-sdk/crypto");
      }
    },
    10_000,
  );

  it(
    "two vaults in one container unlock under the same MEK with distinct VEKs",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "multi-vault-password";

      // Build a two-vault container directly via the helpers (the
      // user-facing add-vault flow lands separately; this
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

      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();
      const recordA = {
        id: idA,
        label: "Vault A",
        createdAt: Date.now(),
        wrappedKey: wrapVekV4(mek, vekA, idA),
        envelope: sealVaultEnvelopeV4(vekA, seedA, mnemonicA, idA),
        addr: "0x" + "a".repeat(40),
      };
      const recordB = {
        id: idB,
        label: "Vault B",
        createdAt: Date.now() + 1,
        wrappedKey: wrapVekV4(mek, vekB, idB),
        envelope: sealVaultEnvelopeV4(vekB, seedB, mnemonicB, idB),
        addr: "0x" + "b".repeat(40),
      };
      const container = {
        version: 5 as const,
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
      const unwrappedA = unwrapVekV4(
        mek2,
        reloaded!.vaults[0]!.wrappedKey,
        reloaded!.vaults[0]!.id,
      );
      const unwrappedB = unwrapVekV4(
        mek2,
        reloaded!.vaults[1]!.wrappedKey,
        reloaded!.vaults[1]!.id,
      );
      expect(Array.from(unwrappedA)).toEqual(Array.from(vekA));
      expect(Array.from(unwrappedB)).toEqual(Array.from(vekB));

      const openedA = openVaultEnvelopeV4(
        unwrappedA,
        reloaded!.vaults[0]!.envelope,
        reloaded!.vaults[0]!.id,
      );
      const openedB = openVaultEnvelopeV4(
        unwrappedB,
        reloaded!.vaults[1]!.envelope,
        reloaded!.vaults[1]!.id,
      );
      expect(openedA.mnemonic).toBe(mnemonicA);
      expect(openedB.mnemonic).toBe(mnemonicB);
      expect(Array.from(openedA.seed)).toEqual(Array.from(seedA));
      expect(Array.from(openedB.seed)).toEqual(Array.from(seedB));
    },
    60_000,
  );

  it(
    "fresh install has neither the legacy key nor a container",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const { loadVaultsContainerV4 } = ks.__internalV4Multi;
      expect(await loadVaultsContainerV4()).toBeNull();
      expect(storage["mono.vault.v4"]).toBeUndefined();
      expect(storage["mono.vaults.v4"]).toBeUndefined();
    },
    10_000,
  );

  // ── P1-003: canonical vaultId AAD binding (V5 always-AAD) ──────────────────

  it("buildVaultAadV4 is byte-deterministic and changes with the vaultId", async () => {
    const ks = await import("./keystore-mldsa.js");
    const { buildVaultAadV4 } = ks.__internalV4Multi;
    const a1 = buildVaultAadV4("vault-A");
    const a2 = buildVaultAadV4("vault-A");
    const b = buildVaultAadV4("vault-B");
    // same vaultId → identical bytes (seal + open build the same AAD)
    expect(Array.from(a1)).toEqual(Array.from(a2));
    // different vaultId → different bytes (the binding term)
    expect(Array.from(a1)).not.toEqual(Array.from(b));
    // carries the format tag + the version byte (V5)
    const tag = "mono.vault.aad.v1";
    expect(new TextDecoder().decode(a1.slice(0, tag.length))).toBe(tag);
    expect(a1[tag.length]).toBe(5);
  });

  it(
    "a cross-vault ciphertext move FAILS the AAD check (wrap + envelope)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const {
        generateMasterKdfParamsV4,
        deriveMekV4,
        generateVekV4,
        wrapVekV4,
        unwrapVekV4,
        sealVaultEnvelopeV4,
        openVaultEnvelopeV4,
      } = ks.__internalV4Multi;

      const mek = await deriveMekV4("pw", generateMasterKdfParamsV4());
      const vek = generateVekV4();
      const seed = new Uint8Array(32).fill(7);
      const mnemonic = "alpha " + "abandon ".repeat(23).trim();

      // Sealed under vault A's id.
      const wrapped = wrapVekV4(mek, vek, "vault-A");
      const env = sealVaultEnvelopeV4(vek, seed, mnemonic, "vault-A");

      // Same id → opens fine.
      expect(() => unwrapVekV4(mek, wrapped, "vault-A")).not.toThrow();
      expect(openVaultEnvelopeV4(vek, env, "vault-A").mnemonic).toBe(mnemonic);

      // Lifted into vault B's record → the AEAD tag check rejects both layers.
      expect(() => unwrapVekV4(mek, wrapped, "vault-B")).toThrow();
      expect(() => openVaultEnvelopeV4(vek, env, "vault-B")).toThrow();
    },
    30_000,
  );

  it("a stored V4 container is DETECTED (restore-from-phrase) without decrypting", async () => {
    const ks = await import("./keystore-mldsa.js");
    const { loadVaultsContainerV4 } = ks.__internalV4Multi;
    // A legacy V4 (no-AAD) container on disk — minimal shape, real ciphertext
    // fields are irrelevant because nothing decrypts it.
    storage["mono.vaults.v4"] = {
      version: 4,
      algo: "ml-dsa-65",
      kdf: "argon2id",
      aead: "xchacha20-poly1305",
      masterKdf: { kdf: "argon2id", m: 65536, t: 3, p: 1, salt: "AAAA" },
      vaults: [{ id: "v1", wrappedKey: {}, envelope: {} }],
      activeVaultId: "v1",
    };
    // Detected as needs-restore (read-only version check)…
    expect(await ks.storedContainerNeedsRestoreV4()).toBe(true);
    // …and the load path returns null (graceful — never decrypts the V4 blob).
    expect(await loadVaultsContainerV4()).toBeNull();
    // No stored container → not a restore case.
    delete storage["mono.vaults.v4"];
    expect(await ks.storedContainerNeedsRestoreV4()).toBe(false);
  });
});

describe("keystore-mldsa v4-multi state machine", () => {
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeStub());
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it(
    "create commits the container directly + leaves it unlocked; unlockContainerV4 reloads the active backend",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "vault-unlock-password";
      const { address } = await ks.createVaultFromNewMnemonic(password);
      // Phase A: create writes the container directly (no legacy single-vault
      // key) and leaves it unlocked.
      expect(storage["mono.vaults.v4"]).toBeDefined();
      expect(storage["mono.vault.v4"]).toBeUndefined();
      expect(ks.isUnlockedV4()).toBe(true);
      expect(ks.getUnlockedAddressV4()).toBe(address);

      // Lock, then unlock through the container path — MEK is re-derived,
      // active vault's backend is reloaded.
      ks.lockV4();
      expect(ks.isUnlockedV4()).toBe(false);
      // Top-tier address privacy: no address is resolvable while locked.
      expect(ks.getUnlockedAddressV4()).toBeNull();
      const r = await ks.unlockContainerV4(password);
      expect(r.address).toBe(address);
      expect(typeof r.vaultId).toBe("string");
      expect(ks.isUnlockedV4()).toBe(true);
      expect(ks.getUnlockedAddressV4()).toBe(address);

      // Wrong password rejects.
      ks.lockV4();
      await expect(ks.unlockContainerV4("wrong")).rejects.toThrow();
      expect(ks.isUnlockedV4()).toBe(false);
    },
    60_000,
  );

  it(
    "lockV4 disposes the held backend, deterministically wiping the ML-DSA-65 secret (S1-01)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "vault-unlock-password";
      await ks.createVaultFromNewMnemonic(password);
      expect(ks.isUnlockedV4()).toBe(true);

      // Capture the live backend reference while unlocked.
      const backend = ks.getUnlockedBackendV4();
      expect(backend).not.toBeNull();
      expect(backend!.disposed).toBe(false);
      // It signs while unlocked.
      expect(() => backend!.sign(new Uint8Array(32))).not.toThrow();

      // Lock wipes the secret on the very object that was in memory — not just
      // a dropped reference (Stage-1 #11): a later sign throws rather than
      // signing with a zeroed key.
      ks.lockV4();
      expect(backend!.disposed).toBe(true);
      expect(() => backend!.sign(new Uint8Array(32))).toThrow(
        "MlDsa65Backend disposed",
      );
      // Public material stays usable (dispose only wipes the secret).
      expect(typeof backend!.getAddress()).toBe("string");
    },
    60_000,
  );

  it(
    "verifyContainerPasswordV4 confirms the right password and rejects a wrong one without mutating unlock state (T1-04a)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "verify-password-correct";
      await ks.createVaultFromNewMnemonic(password);

      // Correct password verifies true. Verification is side-effect free —
      // it does NOT change the unlocked/active state in either direction.
      expect((await ks.verifyContainerPasswordV4(password)).verified).toBe(true);
      expect(ks.isUnlockedV4()).toBe(true);
      expect(ks.getActiveVaultIdV4()).not.toBeNull();

      // Wrong password verifies false (AEAD fails closed), never throws — and
      // reports it as a REAL password verdict, not a structural refusal.
      const wrong = await ks.verifyContainerPasswordV4("wrong-password");
      expect(wrong.verified).toBe(false);
      expect(wrong.verified === false && wrong.structural).toBe(false);

      // Works while LOCKED too (re-derives the MEK from disk) and does not
      // unlock the wallet as a side effect.
      ks.lockV4();
      expect(ks.isUnlockedV4()).toBe(false);
      expect(ks.getActiveVaultIdV4()).toBeNull();
      expect((await ks.verifyContainerPasswordV4(password)).verified).toBe(true);
      expect(ks.isUnlockedV4()).toBe(false);
      expect(ks.getUnlockedAddressV4()).toBeNull();
    },
    60_000,
  );

  it(
    "listVaultsV4 returns null before create and one summary after create",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      expect(await ks.listVaultsV4()).toBeNull();

      const password = "list-password";
      const { address } = await ks.createVaultFromNewMnemonic(password);
      // create commits the container directly, so the summary is available
      // immediately — no unlock/migration round-trip needed.
      const list = await ks.listVaultsV4();
      expect(list).not.toBeNull();
      expect(list!.length).toBe(1);
      expect(list![0]!.addr).toBe(address);
      expect(list![0]!.label).toBe("Wallet 1");
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
      expect(after[1]!.label).toBe("Wallet 2");
      expect(after[1]!.addr).toBe(added.address);
      // addVaultFreshV4 auto-switches the active vault
      // to the newly-created record. The previous design left active
      // unchanged but the popup never wired the follow-up vault-select
      // call, so users saw the old address persist after creating a
      // new vault.
      expect(after[0]!.isActive).toBe(false);
      expect(after[1]!.isActive).toBe(true);
      expect(ks.getUnlockedAddressV4()).toBe(added.address);
    },
    90_000,
  );

  it(
    "addVaultFreshV4 auto-switches active across multiple appends",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "auto-switch-password";
      const first = await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      // After the first vault is created, it is the active one.
      expect(ks.getUnlockedAddressV4()).toBe(first.address);

      const second = await ks.addVaultFreshV4();
      expect(second.address).not.toBe(first.address);
      // Active follows the most recent add.
      expect(ks.getUnlockedAddressV4()).toBe(second.address);

      const third = await ks.addVaultFreshV4();
      expect(third.address).not.toBe(first.address);
      expect(third.address).not.toBe(second.address);
      expect(ks.getUnlockedAddressV4()).toBe(third.address);

      const list = (await ks.listVaultsV4())!;
      expect(list.length).toBe(3);
      const activeRow = list.find((v) => v.isActive)!;
      expect(activeRow.addr).toBe(third.address);
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
      const original = await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      // addVaultFreshV4 now auto-switches active; capture both ids so
      // we can drive selectActiveVaultV4 back to the original to test
      // the switch path explicitly.
      const added = await ks.addVaultFreshV4();
      const beforeSelect = (await ks.listVaultsV4())!;
      const originalRow = beforeSelect.find((v) => v.addr === original.address)!;
      const addedRow = beforeSelect.find((v) => v.id === added.vaultId)!;
      expect(addedRow.isActive).toBe(true);
      expect(originalRow.isActive).toBe(false);

      const sel = await ks.selectActiveVaultV4(originalRow.id);
      expect(sel.address).toBe(original.address);
      expect(ks.getUnlockedAddressV4()).toBe(original.address);

      const after = (await ks.listVaultsV4())!;
      expect(after.find((v) => v.id === originalRow.id)!.isActive).toBe(true);
      expect(after.find((v) => v.id === added.vaultId)!.isActive).toBe(false);

      // Lock clears the MEK cache; subsequent select MUST refuse.
      ks.lockV4();
      await expect(ks.selectActiveVaultV4(added.vaultId)).rejects.toThrow(
        /locked/i,
      );
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
      // createVaultFromNewMnemonic commits the container on disk directly, so
      // it is already present. Read the vault id from the list — rename is
      // supposed to work pre-unlock (labels are non-sensitive metadata).
      const list0 = (await ks.listVaultsV4())!;
      expect(list0.length).toBe(1);
      const vaultId = list0[0]!.id;

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

  it(
    "selectActiveVaultV4 disposes the outgoing vault's backend; new active still signs (S1-01)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "switch-dispose-password";
      const original = await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      // Adding a vault auto-switches active to it; capture its live backend.
      await ks.addVaultFreshV4();
      const outgoing = ks.getUnlockedBackendV4();
      expect(outgoing).not.toBeNull();
      expect(outgoing!.disposed).toBe(false);

      // Switch away — the outgoing backend's ML-DSA-65 secret must be wiped.
      const rows = (await ks.listVaultsV4())!;
      const originalRow = rows.find((v) => v.addr === original.address)!;
      await ks.selectActiveVaultV4(originalRow.id);

      expect(outgoing!.disposed).toBe(true);
      expect(() => outgoing!.sign(new Uint8Array(32))).toThrow(
        "MlDsa65Backend disposed",
      );

      // The newly installed active backend is a different, live instance.
      const nowActive = ks.getUnlockedBackendV4();
      expect(nowActive).not.toBeNull();
      expect(nowActive).not.toBe(outgoing);
      expect(nowActive!.disposed).toBe(false);
      expect(() => nowActive!.sign(new Uint8Array(32))).not.toThrow();
      expect(ks.getUnlockedAddressV4()).toBe(original.address);
    },
    120_000,
  );

  it(
    "addVaultFreshV4 auto-switch disposes the previously-active backend; new active still signs (S1-01)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "add-dispose-password";
      const first = await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);

      // Capture the first vault's live backend (the current active one).
      const outgoing = ks.getUnlockedBackendV4();
      expect(outgoing).not.toBeNull();
      expect(outgoing!.disposed).toBe(false);
      expect(ks.getUnlockedAddressV4()).toBe(first.address);

      // Add-vault auto-switches active → the previous backend must be wiped.
      const second = await ks.addVaultFreshV4();

      expect(outgoing!.disposed).toBe(true);
      expect(() => outgoing!.sign(new Uint8Array(32))).toThrow(
        "MlDsa65Backend disposed",
      );

      const nowActive = ks.getUnlockedBackendV4();
      expect(nowActive).not.toBeNull();
      expect(nowActive).not.toBe(outgoing);
      expect(nowActive!.disposed).toBe(false);
      expect(() => nowActive!.sign(new Uint8Array(32))).not.toThrow();
      expect(ks.getUnlockedAddressV4()).toBe(second.address);
    },
    120_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// multisig vault storage round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("keystore-mldsa multisig vault", () => {
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
    "readMultisigMetaV4 drops a legacy governance proposal missing chainIdHex (B.3, no throw)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "ms-gov-legacy-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const { vaultId } = await ks.addVaultMultisigV4({
        signers: [
          makeSigner({ id: "s-a", address: fakeAddress(0x01) }),
          makeSigner({ id: "s-b", address: fakeAddress(0x02) }),
        ],
        threshold: 2,
      });

      // Inject a pre-P1-006 legacy governance proposal (no chainIdHex) + a valid
      // one directly into the persisted container, bypassing the write path
      // (which would filter the legacy one on the way in).
      const govBase = {
        proposedBy: "s-a",
        createdAt: 1,
        expiresAt: 1_000_000_000_000,
        vaultAddress: fakeAddress(0xcc),
        action: { kind: "change-threshold" as const, threshold: 1 },
        approvals: [],
        rejections: [],
        status: "pending" as const,
      };
      const container = storage["mono.vaults.v4"] as {
        vaults: Array<{ id: string; multisig?: { governance: unknown[] } }>;
      };
      const rec = container.vaults.find((r) => r.id === vaultId)!;
      rec.multisig!.governance = [
        { ...govBase, id: "g-legacy" }, // NO chainIdHex → dropped on load
        { ...govBase, id: "g-valid", chainIdHex: "0x10f2c" },
      ];

      const reloaded = (await ks.readMultisigMetaV4(vaultId))!;
      expect(reloaded.governance.map((g) => g.id)).toEqual(["g-valid"]);
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
      // create now leaves the container unlocked; lock it to exercise the
      // locked-container guard.
      ks.lockV4();

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
        mnemonicToMlDsa65Seed,
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
      const seed = mnemonicToMlDsa65Seed(mnemonic);
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
      // create leaves the container unlocked; lock it to exercise the guard.
      ks.lockV4();

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

describe("keystore-mldsa passkey state", () => {
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
    "round-trips the credential public-key fields (Part 1a)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "pk-pubkey-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const id = (await ks.listVaultsV4())![0]!.id;
      await ks.addPasskeyCredentialV4(id, {
        credentialId: "cred-pk",
        name: "Key",
        kind: "platform",
        createdAt: 1_000_000,
        publicKeySpki: "c3BraS1kZXItYmFzZTY0dXJs",
        alg: -7,
        signCount: 5,
      });
      // Survives the storage round-trip (passkeyStateForStorage →
      // clonePasskeyState) intact.
      const state = await ks.readPasskeyStateV4(id);
      const c = state.credentials[0]!;
      expect(c.publicKeySpki).toBe("c3BraS1kZXItYmFzZTY0dXJs");
      expect(c.alg).toBe(-7);
      expect(c.signCount).toBe(5);
    },
    120_000,
  );

  it(
    "reads back a legacy credential with NO pubkey fields (undefined, no throw)",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const password = "pk-legacy-password";
      await ks.createVaultFromNewMnemonic(password);
      await ks.unlockContainerV4(password);
      const id = (await ks.listVaultsV4())![0]!.id;
      // `fakeCred` is the pre-Part-1a shape (no publicKeySpki/alg/signCount) —
      // a vault that predates this change. It must read back cleanly.
      await ks.addPasskeyCredentialV4(id, fakeCred(9));
      const state = await ks.readPasskeyStateV4(id);
      const c = state.credentials[0]!;
      expect(c.credentialId).toBe("cred-9");
      expect(c.publicKeySpki).toBeUndefined();
      expect(c.alg).toBeUndefined();
      expect(c.signCount).toBeUndefined();
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

describe("keystore-mldsa passkey BigInt round-trip", () => {
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

describe("keystore-mldsa SLH-DSA backup CRUD", () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// T1-03 (Item B) — session-MEK rehydrate cap. Needs a chrome stub WITH a
// storage.session area (the v4-multi stub above is local-only, so the session
// path no-ops there).
// ─────────────────────────────────────────────────────────────────────────────
describe("keystore-mldsa session-MEK rehydrate cap (T1-03)", () => {
  let local: StorageMap;
  let session: StorageMap;

  function area(store: StorageMap) {
    return {
      get: (keys: string[], cb: (res: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        queueMicrotask(() => cb(out));
      },
      set: (entries: Record<string, unknown>, cb: () => void) => {
        for (const [k, v] of Object.entries(entries)) store[k] = v;
        queueMicrotask(() => cb());
      },
      remove: (keys: string[] | string, cb?: () => void) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete store[k];
        if (cb) queueMicrotask(() => cb());
      },
    };
  }

  beforeEach(() => {
    local = {};
    session = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: area(local), session: area(session) },
    };
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const MEK_KEY = "mono.session.mek.v4";
  // 2026-06-28 auto-lock overhaul: the configured auto-lock deadline is now the
  // single restore authority (SESSION_KEY_AUTO_LOCK_DEADLINE), replacing the old
  // independent 5-min rehydrate cap. In production the SW's resetAutoLock writes
  // this; these keystore unit tests seed it directly.
  const AUTOLOCK_KEY = "autoLockDeadline";

  it(
    "rehydrates within the auto-lock window and refuses + wipes the session MEK once past it",
    async () => {
      const ks1 = await import("./keystore-mldsa.js");
      await ks1.createVaultFromNewMnemonic("rehydrate-cap-password");
      // The MEK is mirrored to session; the auto-lock deadline (the single
      // restore authority, written by the SW's resetAutoLock in production) is
      // seeded here in the FUTURE to model an unlocked, within-window session.
      expect(typeof session[MEK_KEY]).toBe("string");
      session[AUTOLOCK_KEY] = Date.now() + 60_000;

      // Simulate an SW restart: fresh module state (locked), session intact.
      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      expect(ks2.isUnlockedV4()).toBe(false);
      // Within the window → silent rehydrate succeeds.
      expect((await ks2.tryRestoreFromSessionV4()).ok).toBe(true);
      expect(ks2.isUnlockedV4()).toBe(true);

      // Expire the auto-lock deadline, restart again → restore refused + session
      // MEK wiped (no restore past the deadline).
      session[AUTOLOCK_KEY] = Date.now() - 1;
      vi.resetModules();
      const ks3 = await import("./keystore-mldsa.js");
      expect((await ks3.tryRestoreFromSessionV4()).ok).toBe(false);
      expect(ks3.isUnlockedV4()).toBe(false);
      expect(session[MEK_KEY]).toBeUndefined();
    },
    60_000,
  );

  it(
    "treats an absent auto-lock deadline as expired (fail closed)",
    async () => {
      const ks1 = await import("./keystore-mldsa.js");
      await ks1.createVaultFromNewMnemonic("rehydrate-absent-password");
      // MEK present, but NO auto-lock deadline (the single restore authority) →
      // fail-closed: refuse + wipe. Never restore on a missing bound.
      expect(typeof session[MEK_KEY]).toBe("string");
      expect(session[AUTOLOCK_KEY]).toBeUndefined();
      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      expect((await ks2.tryRestoreFromSessionV4()).ok).toBe(false);
      expect(session[MEK_KEY]).toBeUndefined();
    },
    60_000,
  );

  it(
    "a fired lock clears the session MEK; a subsequent restore refuses (#17)",
    async () => {
      const ks1 = await import("./keystore-mldsa.js");
      await ks1.createVaultFromNewMnemonic("fired-lock-password");
      // Unlocked, within-window session.
      expect(typeof session[MEK_KEY]).toBe("string");
      session[AUTOLOCK_KEY] = Date.now() + 60_000;

      // A fired auto-lock invokes lockV4() (its keystore step), which clears the
      // session MEK via clearMekFromSessionV4 — so a within-window restore after
      // a fired auto-lock has no MEK to re-unlock from.
      ks1.lockV4();
      await new Promise((r) => setTimeout(r, 10)); // fire-and-forget session clear

      expect(session[MEK_KEY]).toBeUndefined();

      // A subsequent SW boot refuses the password-less restore (fail closed).
      vi.resetModules();
      const ks2 = await import("./keystore-mldsa.js");
      expect((await ks2.tryRestoreFromSessionV4()).ok).toBe(false);
      expect(ks2.isUnlockedV4()).toBe(false);
    },
    60_000,
  );
});

describe("commitVaultFromSeed error-path zeroization (P2-004)", () => {
  beforeEach(() => {
    installChromeStub();
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("@noble/hashes/argon2.js");
    vi.doUnmock("@monolythium/core-sdk/crypto");
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  // Mock argon2 so deriveMekV4 returns a buffer we hold (to observe the wipe),
  // and MlDsa65Backend so we can spy on dispose() + skip real keygen. The
  // mnemonic helpers (generateMnemonic / mnemonicToMlDsa65Seed) stay
  // real via importOriginal.
  function installMocks(): {
    capturedMek: Uint8Array;
    disposeSpy: ReturnType<typeof vi.fn>;
  } {
    const capturedMek = new Uint8Array(32).fill(7);
    vi.doMock("@noble/hashes/argon2.js", () => ({
      argon2idAsync: async () => capturedMek,
    }));
    const disposeSpy = vi.fn();
    vi.doMock("@monolythium/core-sdk/crypto", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        MlDsa65Backend: {
          fromSeed: () => ({
            getAddress: async () => "0x" + "ab".repeat(20),
            dispose: disposeSpy,
          }),
        },
      };
    });
    return { capturedMek, disposeSpy };
  }

  it("zeroizes the MEK + disposes the backend when the commit throws after allocation", async () => {
    const { capturedMek, disposeSpy } = installMocks();
    // Force saveVaultsContainerV4 to reject: storage.local.set throws. This is
    // AFTER mek + backend are allocated and BEFORE ownership transfers.
    const c = (
      globalThis as unknown as {
        chrome: { storage: { local: { set: unknown } } };
      }
    ).chrome;
    c.storage.local.set = () => {
      throw new Error("disk full");
    };

    const ks = await import("./keystore-mldsa.js");
    await expect(ks.createVaultFromNewMnemonic("pw")).rejects.toThrow();

    // The derived MEK buffer was zeroed, and the backend disposed — on throw.
    expect(Array.from(capturedMek)).toEqual(new Array(32).fill(0));
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(ks.isUnlockedV4()).toBe(false);
  });

  it("does NOT wipe the MEK / dispose the backend on success (ownership transfers)", async () => {
    const { capturedMek, disposeSpy } = installMocks();
    const ks = await import("./keystore-mldsa.js");

    const { address } = await ks.createVaultFromNewMnemonic("pw");
    expect(address).toBe("0x" + "ab".repeat(20));

    // mek stays live (owned by the session), backend not disposed, unlocked.
    expect(Array.from(capturedMek)).toEqual(new Array(32).fill(7));
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(ks.isUnlockedV4()).toBe(true);
  });
});

describe("sealVaultEnvelopeV4 mnPlain zeroization (P2-005)", () => {
  beforeEach(() => {
    installChromeStub();
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("@noble/ciphers/chacha.js");
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  // Mock xchacha so the SECOND encrypt (the mnemonic) captures its arg — which
  // IS the internal mnPlain buffer — so we can assert the finally zeroed it.
  // The first encrypt (seed) returns a fake ciphertext.
  function mockXchachaCapture(throwOnMnemonic: boolean): {
    mnPlain: Uint8Array | null;
  } {
    const cap: { mnPlain: Uint8Array | null } = { mnPlain: null };
    let n = 0;
    vi.doMock("@noble/ciphers/chacha.js", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        xchacha20poly1305: () => ({
          encrypt: (data: Uint8Array) => {
            n++;
            if (n === 1) return new Uint8Array(data.length + 16); // seed ct (fake)
            cap.mnPlain = data; // 2nd call's arg == mnPlain
            if (throwOnMnemonic) throw new Error("encrypt failed");
            return new Uint8Array(data.length + 16);
          },
        }),
      };
    });
    return cap;
  }

  it("zeroes mnPlain in the finally even when encrypt() throws", async () => {
    const cap = mockXchachaCapture(true);
    const ks = await import("./keystore-mldsa.js");
    const { generateVekV4, sealVaultEnvelopeV4 } = ks.__internalV4Multi;
    const vek = generateVekV4();
    const seed = new Uint8Array(32).fill(9);

    expect(() =>
      sealVaultEnvelopeV4(vek, seed, "alpha bravo charlie", "v-zero"),
    ).toThrow();
    expect(cap.mnPlain).not.toBeNull();
    expect(Array.from(cap.mnPlain!)).toEqual(
      new Array(cap.mnPlain!.length).fill(0),
    );
  });

  it("zeroes mnPlain on the happy path too", async () => {
    const cap = mockXchachaCapture(false);
    const ks = await import("./keystore-mldsa.js");
    const { generateVekV4, sealVaultEnvelopeV4 } = ks.__internalV4Multi;
    const vek = generateVekV4();
    const seed = new Uint8Array(32).fill(9);

    const env = sealVaultEnvelopeV4(vek, seed, "alpha bravo charlie", "v-zero");
    expect(typeof env.mnemonicCiphertext).toBe("string");
    expect(cap.mnPlain).not.toBeNull();
    expect(Array.from(cap.mnPlain!)).toEqual(
      new Array(cap.mnPlain!.length).fill(0),
    );
  });
});

describe("sent-address integrity HMAC (P5-007)", () => {
  beforeEach(() => {
    installChromeStub();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const CHAIN = "0x10f2c"; // 69420
  const RECIP = "0xrecipient000000000000000000000000000001";

  it(
    "computes a deterministic, cross-bound tag and verifies it; fails safe when tampered or locked",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const sa = await import("../shared/sent-addresses.js");
      await ks.createVaultFromNewMnemonic("vault-unlock-password");
      const vault = ks.getUnlockedAddressV4()!.toLowerCase();

      const msg = sa.canonicalSentAddrMessage(vault, CHAIN, RECIP);
      const tag = ks.computeSentAddrTagV4(msg);
      expect(tag).toMatch(/^[0-9a-f]{64}$/); // 32-byte HMAC-SHA256, hex

      // Deterministic + verifies.
      expect(ks.computeSentAddrTagV4(msg)).toBe(tag);
      expect(ks.verifySentAddrTagV4(msg, tag!)).toBe(true);

      // Cross-binding: a tag is not valid for a different recipient / chain / vault.
      expect(
        ks.computeSentAddrTagV4(sa.canonicalSentAddrMessage(vault, CHAIN, "0xother")),
      ).not.toBe(tag);
      expect(
        ks.verifySentAddrTagV4(sa.canonicalSentAddrMessage(vault, "0x1", RECIP), tag!),
      ).toBe(false);
      expect(
        ks.verifySentAddrTagV4(
          sa.canonicalSentAddrMessage("0xothervault", CHAIN, RECIP),
          tag!,
        ),
      ).toBe(false);

      // Tampered / wrong-length / non-hex tag → false, never throws.
      expect(ks.verifySentAddrTagV4(msg, "00".repeat(32))).toBe(false);
      expect(ks.verifySentAddrTagV4(msg, "abcd")).toBe(false); // wrong length
      expect(ks.verifySentAddrTagV4(msg, "nothex!!")).toBe(false); // invalid hex

      // Locked → compute null, verify false (fail-safe: the warning fires).
      ks.lockV4();
      expect(ks.computeSentAddrTagV4(msg)).toBeNull();
      expect(ks.verifySentAddrTagV4(msg, tag!)).toBe(false);
    },
    60_000,
  );

  it(
    "write→verify (handler logic): wallet entry verifies; planted/legacy/missing do not; self-heals on re-send",
    async () => {
      const ks = await import("./keystore-mldsa.js");
      const sa = await import("../shared/sent-addresses.js");
      await ks.createVaultFromNewMnemonic("vault-unlock-password");
      const vault = ks.getUnlockedAddressV4()!.toLowerCase();

      // Exactly what the `wallet-recipient-sent-verified` handler does:
      // read store → parseSentEntries → find addr → verify its tag.
      const verifyFromStore = (raw: unknown, recipient: string): boolean => {
        const e = sa
          .parseSentEntries(raw)
          .find((x) => x.a === recipient.toLowerCase());
        return (
          !!e &&
          ks.verifySentAddrTagV4(
            sa.canonicalSentAddrMessage(vault, CHAIN, recipient.toLowerCase()),
            e.t,
          )
        );
      };

      // Wallet-written entry (the SW write path) verifies.
      const tag = ks.computeSentAddrTagV4(
        sa.canonicalSentAddrMessage(vault, CHAIN, RECIP),
      )!;
      const written = { v: 1, entries: sa.addSentEntry([], RECIP, tag) };
      expect(verifyFromStore(written, RECIP)).toBe(true);

      // Planted well-formed entry with a FORGED tag → false (warning fires).
      const planted = { v: 1, entries: [{ a: RECIP, t: "ab".repeat(32) }] };
      expect(verifyFromStore(planted, RECIP)).toBe(false);

      // Legacy {addrs} entry → parseSentEntries drops it → false (warning fires).
      expect(verifyFromStore({ addrs: [RECIP] }, RECIP)).toBe(false);

      // Missing entry → false.
      expect(verifyFromStore(written, "0xnotsent")).toBe(false);

      // Self-heal: a legitimate re-send writes a fresh tag over the legacy list.
      const reSent = {
        v: 1,
        entries: sa.addSentEntry(sa.parseSentEntries({ addrs: [RECIP] }), RECIP, tag),
      };
      expect(verifyFromStore(reSent, RECIP)).toBe(true);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// removeVaultV4 — password-verified single-vault removal.
//
// Argon2id cost: this describe deliberately does NOT reset modules between
// tests. The container is built once in beforeAll (one real derivation) and the
// module instance is kept alive so the cached MEK stays warm; each test restores
// a deep-cloned storage snapshot instead of rebuilding. The only derivation a
// test pays is the one removeVaultV4 itself performs, which is the thing under
// test. Cheapening the KDF is not an option — isVaultsContainerV4 floors the
// params at m >= 64 MiB / t >= 2 and rejects anything weaker.
// ---------------------------------------------------------------------------
describe("removeVaultV4 — password-verified single-vault removal", () => {
  const PASSWORD = "correct-horse-battery-staple";
  type Ks = typeof import("./keystore-mldsa.js");

  interface TestVault {
    id: string;
    label: string;
    addr: string;
    createdAt: number;
    envelope: unknown;
    wrappedKey: unknown;
    kind?: string;
    multisig?: unknown;
  }
  interface TestContainer {
    vaults: TestVault[];
    activeVaultId: string;
  }

  let storage: StorageMap;
  let ks: Ks;
  let KEY: string;
  let snapshot: string;
  let idA: string;
  let idB: string;
  let idC: string;

  const container = (): TestContainer =>
    JSON.parse(JSON.stringify(storage[KEY])) as TestContainer;

  const writeContainer = (c: TestContainer) => {
    storage[KEY] = JSON.parse(JSON.stringify(c));
  };

  beforeAll(async () => {
    ({ storage } = installChromeStub());
    vi.resetModules();
    ks = await import("./keystore-mldsa.js");
    KEY = ks.__internalV4Multi.VAULTS_CONTAINER_KEY_V4;

    await ks.createVaultFromNewMnemonic(PASSWORD);
    await ks.addVaultFreshV4("Wallet 2");
    await ks.addVaultFreshV4("Wallet 3");

    const c = container();
    // Deterministic ordering for the successor-election tests: once A (active)
    // is gone, B is the oldest survivor.
    c.vaults[0]!.createdAt = 3_000;
    c.vaults[1]!.createdAt = 1_000;
    c.vaults[2]!.createdAt = 2_000;
    c.activeVaultId = c.vaults[0]!.id;
    writeContainer(c);

    idA = c.vaults[0]!.id;
    idB = c.vaults[1]!.id;
    idC = c.vaults[2]!.id;
    snapshot = JSON.stringify(storage[KEY]);

    // Make in-memory state coherent with the container: addVaultFreshV4 leaves
    // the newest vault's backend held even though activeVaultId is unchanged.
    await ks.selectActiveVaultV4(idA);
  }, 120_000);

  beforeEach(async () => {
    storage[KEY] = JSON.parse(snapshot);
    // A previous test may have locked or switched the active vault. Re-unlock
    // only when actually locked, so the common path costs no derivation.
    if (!ks.isUnlockedV4()) await ks.unlockContainerV4(PASSWORD);
    await ks.selectActiveVaultV4(idA);
  }, 60_000);

  it(
    "removes exactly the target vault and leaves every survivor byte-identical",
    async () => {
      const survivorsBefore = container().vaults.filter((v) => v.id !== idC);

      await ks.removeVaultV4(PASSWORD, idC);

      const after = container();
      expect(after.vaults.map((v) => v.id)).toEqual([idA, idB]);
      // Ciphertext, label, address, timestamps — nothing about the survivors
      // may shift when a neighbour is removed.
      expect(after.vaults).toEqual(survivorsBefore);
    },
    60_000,
  );

  it(
    "reports the removed id and leaves the active id alone for a non-active vault",
    async () => {
      const r = await ks.removeVaultV4(PASSWORD, idC);
      expect(r.removedId).toBe(idC);
      expect(r.newActiveVaultId).toBe(idA);
      expect(container().activeVaultId).toBe(idA);
    },
    60_000,
  );

  it(
    "removes nothing when the password is wrong",
    async () => {
      const before = JSON.stringify(storage[KEY]);

      await expect(ks.removeVaultV4("not-the-password", idC)).rejects.toThrow();

      // Byte-identical: a failed attempt must not rewrite the container at all.
      expect(JSON.stringify(storage[KEY])).toBe(before);
      expect(container().vaults).toHaveLength(3);
    },
    60_000,
  );

  it(
    "removes nothing when the vault id is unknown",
    async () => {
      const before = JSON.stringify(storage[KEY]);
      await expect(
        ks.removeVaultV4(PASSWORD, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow(/unknown vault id/);
      expect(JSON.stringify(storage[KEY])).toBe(before);
    },
    60_000,
  );

  it(
    "removes nothing when the vault id is malformed",
    async () => {
      const before = JSON.stringify(storage[KEY]);
      await expect(ks.removeVaultV4(PASSWORD, "")).rejects.toThrow(
        /unknown vault id/,
      );
      expect(JSON.stringify(storage[KEY])).toBe(before);
    },
    60_000,
  );

  it(
    "refuses to remove the last remaining vault, with a distinct catchable error",
    async () => {
      const c = container();
      c.vaults = [c.vaults[0]!];
      c.activeVaultId = c.vaults[0]!.id;
      writeContainer(c);
      const before = JSON.stringify(storage[KEY]);

      // Distinct from "wrong password" and from "unknown vault id" so the UI
      // can route the user to Reset wallet instead of blaming their typing.
      await expect(ks.removeVaultV4(PASSWORD, idA)).rejects.toThrow(
        /cannot remove the last vault/,
      );
      expect(JSON.stringify(storage[KEY])).toBe(before);
    },
    60_000,
  );

  it(
    "elects the survivor with the lowest createdAt when the active vault is removed",
    async () => {
      // A is active (createdAt 3000); survivors are B (1000) and C (2000).
      const r = await ks.removeVaultV4(PASSWORD, idA);
      expect(r.newActiveVaultId).toBe(idB);
      expect(container().activeVaultId).toBe(idB);
      expect(r.newActiveAddress).toMatch(/^0x[0-9a-f]{40}$/);
    },
    60_000,
  );

  it(
    "breaks a createdAt tie by container order, taking the earlier record",
    async () => {
      const c = container();
      // B and C both at 1000; B sits first in the array.
      c.vaults[2]!.createdAt = 1_000;
      writeContainer(c);

      const r = await ks.removeVaultV4(PASSWORD, idA);
      expect(r.newActiveVaultId).toBe(idB);
    },
    60_000,
  );

  it(
    "disposes the outgoing backend so the removed vault's secret is zeroized",
    async () => {
      const outgoing = ks.getUnlockedBackendV4();
      expect(outgoing).not.toBeNull();
      const disposeSpy = vi.spyOn(outgoing!, "dispose");

      await ks.removeVaultV4(PASSWORD, idA);

      expect(disposeSpy).toHaveBeenCalled();
      // And the held backend is genuinely the successor's, not the dead one.
      expect(ks.getUnlockedBackendV4()).not.toBe(outgoing);
    },
    60_000,
  );

  it(
    "leaves the container intact and usable when the persist fails",
    async () => {
      const before = JSON.stringify(storage[KEY]);
      const held = ks.getUnlockedBackendV4();
      const realSet = chrome.storage.local.set;
      (chrome.storage.local as unknown as { set: unknown }).set = () => {
        throw new Error("disk full");
      };

      try {
        await expect(ks.removeVaultV4(PASSWORD, idC)).rejects.toThrow(
          /disk full/,
        );
      } finally {
        (chrome.storage.local as unknown as { set: unknown }).set = realSet;
      }

      // A half-applied removal must be impossible: the on-disk container is
      // untouched AND the in-memory session still holds the same live backend.
      expect(JSON.stringify(storage[KEY])).toBe(before);
      expect(container().vaults).toHaveLength(3);
      expect(ks.getUnlockedBackendV4()).toBe(held);
      expect(ks.isUnlockedV4()).toBe(true);
    },
    60_000,
  );

  it(
    "names the multisig wallets that listed the removed vault as a signer",
    async () => {
      const c = container();
      const target = c.vaults.find((v) => v.id === idC)!;
      c.vaults[1]!.kind = "multisig";
      c.vaults[1]!.label = "Treasury";
      c.vaults[1]!.multisig = {
        signers: [
          {
            id: "s1",
            label: "C",
            address: target.addr,
            pubkey: "0x00",
            role: "self",
            vaultId: idC,
          },
        ],
        threshold: 1,
        proposals: [],
        governance: [],
      };
      writeContainer(c);

      const r = await ks.removeVaultV4(PASSWORD, idC);
      expect(r.affectedMultisigLabels).toEqual(["Treasury"]);
    },
    60_000,
  );

  it(
    "returns an empty affected-multisig list when nothing referenced the vault",
    async () => {
      const r = await ks.removeVaultV4(PASSWORD, idC);
      expect(r.affectedMultisigLabels).toEqual([]);
    },
    60_000,
  );

  // LAST: this test clears the cached MEK. beforeEach re-unlocks when needed,
  // but keeping it last means no other test pays for that extra derivation.
  it(
    "removes nothing when the container is locked",
    async () => {
      const before = JSON.stringify(storage[KEY]);
      ks.lockV4();
      expect(ks.isUnlockedV4()).toBe(false);

      await expect(ks.removeVaultV4(PASSWORD, idC)).rejects.toThrow(
        /container is locked/,
      );
      expect(JSON.stringify(storage[KEY])).toBe(before);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// exportMnemonicForVaultV4 — per-vault recovery-phrase export.
//
// Same argon2 discipline as the removeVaultV4 block above: one container built
// in beforeAll, module instance kept warm, snapshot restored per test.
// ---------------------------------------------------------------------------
describe("exportMnemonicForVaultV4 — per-vault recovery-phrase export", () => {
  const PASSWORD = "correct-horse-battery-staple";
  type Ks = typeof import("./keystore-mldsa.js");

  interface TestVault {
    id: string;
    label: string;
    addr: string;
    envelope: unknown;
    wrappedKey: unknown;
  }
  interface TestContainer {
    vaults: TestVault[];
    activeVaultId: string;
  }

  let storage: StorageMap;
  let ks: Ks;
  let KEY: string;
  let snapshot: string;
  let idActive: string;
  let idOther: string;
  let mnemonicActive: string;
  let mnemonicOther: string;

  const container = (): TestContainer =>
    JSON.parse(JSON.stringify(storage[KEY])) as TestContainer;

  beforeAll(async () => {
    ({ storage } = installChromeStub());
    vi.resetModules();
    ks = await import("./keystore-mldsa.js");
    KEY = ks.__internalV4Multi.VAULTS_CONTAINER_KEY_V4;

    const first = await ks.createVaultFromNewMnemonic(PASSWORD);
    mnemonicActive = first.mnemonic;
    const second = await ks.addVaultFreshV4("Wallet 2");
    mnemonicOther = second.mnemonic;

    const c = container();
    idActive = c.vaults[0]!.id;
    idOther = c.vaults[1]!.id;
    // addVaultFreshV4 does not change activeVaultId, but it does leave the new
    // vault's backend held; resync so "active" means the same thing on disk and
    // in memory.
    await ks.selectActiveVaultV4(idActive);
    snapshot = JSON.stringify(storage[KEY]);
  }, 120_000);

  beforeEach(() => {
    storage[KEY] = JSON.parse(snapshot);
  });

  it(
    "returns the NON-active vault's own phrase, not the active one's",
    async () => {
      const r = await ks.exportMnemonicForVaultV4(PASSWORD, idOther);
      expect(r.mnemonic).toBe(mnemonicOther);
      expect(r.mnemonic).not.toBe(mnemonicActive);
      expect(r.mnemonic.split(/\s+/)).toHaveLength(24);
    },
    60_000,
  );

  it(
    "agrees with exportMnemonicV4 for the active vault",
    async () => {
      const viaId = await ks.exportMnemonicForVaultV4(PASSWORD, idActive);
      const viaActive = await ks.exportMnemonicV4(PASSWORD);
      expect(viaId.mnemonic).toBe(mnemonicActive);
      expect(viaActive.mnemonic).toBe(viaId.mnemonic);
    },
    60_000,
  );

  it(
    "fails with no mnemonic when the password is wrong",
    async () => {
      await expect(
        ks.exportMnemonicForVaultV4("not-the-password", idOther),
      ).rejects.toThrow();
    },
    60_000,
  );

  it(
    "rejects an unknown vault id before deriving anything",
    async () => {
      await expect(
        ks.exportMnemonicForVaultV4(PASSWORD, "no-such-vault"),
      ).rejects.toThrow(/unknown vault id/);
    },
    60_000,
  );

  it("binds every envelope to its own vaultId at the AEAD tag", async () => {
    // The load-bearing property for per-wallet reveal: a ciphertext cannot be
    // opened under a different vault's id. Exercised at the primitive level so
    // it costs no derivation.
    const { generateVekV4, sealVaultEnvelopeV4, openVaultEnvelopeV4 } =
      ks.__internalV4Multi;
    const vek = generateVekV4();
    const seed = new Uint8Array(32).fill(9);
    const sealed = sealVaultEnvelopeV4(vek, seed, "phrase for vault A", "vault-A");

    // Same id round-trips.
    expect(openVaultEnvelopeV4(vek, sealed, "vault-A").mnemonic).toBe(
      "phrase for vault A",
    );
    // A different id fails the tag rather than yielding the phrase.
    expect(() => openVaultEnvelopeV4(vek, sealed, "vault-B")).toThrow();
  });

  it(
    "refuses a lifted envelope rather than surfacing a neighbour's phrase",
    async () => {
      // End-to-end version of the same property: tamper the container so the
      // OTHER vault's record carries the ACTIVE vault's envelope. If the AAD
      // binding were absent this would hand back the active vault's phrase
      // under the other vault's id.
      const c = container();
      const activeRec = c.vaults.find((v) => v.id === idActive)!;
      const otherRec = c.vaults.find((v) => v.id === idOther)!;
      otherRec.envelope = activeRec.envelope;
      storage[KEY] = JSON.parse(JSON.stringify(c));

      await expect(
        ks.exportMnemonicForVaultV4(PASSWORD, idOther),
      ).rejects.toThrow();
    },
    60_000,
  );

  it(
    "writes nothing and logs nothing while exporting",
    async () => {
      const before = JSON.stringify(storage[KEY]);
      const spies = (["log", "warn", "error", "debug", "info"] as const).map(
        (m) => vi.spyOn(console, m).mockImplementation(() => {}),
      );

      let mnemonic: string;
      try {
        mnemonic = (await ks.exportMnemonicForVaultV4(PASSWORD, idOther))
          .mnemonic;
        const logged = spies
          .flatMap((s) => s.mock.calls)
          .flat()
          .map((a) => String(a))
          .join(" ");
        // Not just "the phrase is absent" — no word of it may appear.
        expect(logged).not.toContain(mnemonic);
        for (const word of mnemonic.split(/\s+/)) {
          expect(logged).not.toContain(word);
        }
      } finally {
        for (const s of spies) s.mockRestore();
      }

      // A read must not mutate the container, and must not stash the phrase
      // anywhere in storage.
      expect(JSON.stringify(storage[KEY])).toBe(before);
      expect(JSON.stringify(storage)).not.toContain(mnemonic);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// DA-002 — a container write that fails must not report success.
//
// `chrome.storage.local.set` signals failure by setting `chrome.runtime.lastError`
// INSIDE the callback; it neither throws nor rejects. Swallowing that made every
// "did the write land" guarantee above it vacuous — a failed wallet removal or
// wallet creation was reported to the user as success.
// ---------------------------------------------------------------------------

/** A container that satisfies `isVaultsContainerV4` without any crypto, so these
 *  tests cost zero Argon2id derivations. */
function fixtureContainer(vaults: Array<{ id: string; label: string }>) {
  return {
    version: 5,
    algo: "ml-dsa-65",
    kdf: "argon2id",
    aead: "xchacha20-poly1305",
    masterKdf: { kdf: "argon2id", m: 65536, t: 3, p: 1, salt: "c2FsdA==" },
    vaults: vaults.map((v) => ({ ...v, createdAt: 1_000, addr: "0x" + "11".repeat(20) })),
    activeVaultId: vaults[0]?.id ?? "",
  };
}

/** Chrome stub whose `set` can be made to fail the way the real API does. */
function installFailableChromeStub(): {
  storage: StorageMap;
  failNextSet: (message: string | null) => void;
} {
  const storage: StorageMap = {};
  let setFailure: string | null = null;
  const runtime: { lastError?: { message: string } } = {};
  (globalThis as { chrome?: unknown }).chrome = {
    runtime,
    storage: {
      local: {
        // Real `chrome.storage.local` structured-clones across the boundary, so
        // a reader NEVER shares an object reference with the store. Cloning here
        // is not politeness — without it an in-memory mutation would write
        // through to "disk" with no `set` at all, which would make a failed-write
        // assertion pass for the wrong reason and make an interleaving test
        // prove nothing.
        get: (keys: string[], cb: (res: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in storage) out[k] = JSON.parse(JSON.stringify(storage[k]));
          }
          queueMicrotask(() => cb(out));
        },
        set: (entries: Record<string, unknown>, cb: () => void) => {
          if (setFailure !== null) {
            const msg = setFailure;
            queueMicrotask(() => {
              runtime.lastError = { message: msg };
              cb();
              delete runtime.lastError;
            });
            return;
          }
          for (const [k, v] of Object.entries(entries)) {
            storage[k] = JSON.parse(JSON.stringify(v));
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
  return {
    storage,
    failNextSet: (message: string | null) => {
      setFailure = message;
    },
  };
}

describe("container write failure (DA-002)", () => {
  let ks: typeof import("./keystore-mldsa.js");
  let storage: StorageMap;
  let failNextSet: (m: string | null) => void;
  let KEY: string;

  beforeEach(async () => {
    ({ storage, failNextSet } = installFailableChromeStub());
    vi.resetModules();
    ks = await import("./keystore-mldsa.js");
    KEY = ks.__internalV4Multi.VAULTS_CONTAINER_KEY_V4;
    storage[KEY] = fixtureContainer([
      { id: "v-1", label: "Wallet 1" },
      { id: "v-2", label: "Wallet 2" },
    ]);
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("rejects when chrome.runtime.lastError is set on the write", async () => {
    failNextSet("QUOTA_BYTES quota exceeded");
    await expect(
      ks.__internalV4Multi.saveVaultsContainerV4(
        fixtureContainer([{ id: "v-1", label: "Wallet 1" }]) as never,
      ),
    ).rejects.toThrow(/QUOTA_BYTES quota exceeded/);
  });

  it("still resolves when the write succeeds", async () => {
    await expect(
      ks.__internalV4Multi.saveVaultsContainerV4(
        fixtureContainer([{ id: "v-1", label: "Renamed" }]) as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("a caller does NOT report success when the write failed", async () => {
    failNextSet("I/O error");
    await expect(ks.renameVaultV4("v-1", "New Label")).rejects.toThrow(
      /I\/O error/,
    );
    // And the on-disk container is unchanged — the failed write persisted nothing.
    const onDisk = storage[KEY] as { vaults: Array<{ label: string }> };
    expect(onDisk.vaults[0]!.label).toBe("Wallet 1");
  });
});

describe("container write failure leaves the session intact (DA-002)", () => {
  // Costs ONE real Argon2id derivation, shared across the block via beforeAll.
  let ks: typeof import("./keystore-mldsa.js");
  let storage: StorageMap;
  let failNextSet: (m: string | null) => void;
  let KEY: string;
  let addrBefore: string | null;

  beforeAll(async () => {
    ({ storage, failNextSet } = installFailableChromeStub());
    vi.resetModules();
    ks = await import("./keystore-mldsa.js");
    KEY = ks.__internalV4Multi.VAULTS_CONTAINER_KEY_V4;
    await ks.createVaultFromNewMnemonic("correct horse battery staple 42");
    addrBefore = ks.getUnlockedAddressV4();
  }, 60_000);

  afterAll(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("a failed vault-add leaves the wallet unlocked on the SAME address", async () => {
    const before = JSON.stringify(storage[KEY]);
    failNextSet("QUOTA_BYTES quota exceeded");
    await expect(ks.addVaultFreshV4("Wallet 2")).rejects.toThrow(
      /QUOTA_BYTES/,
    );
    failNextSet(null);
    // The session did not move to the half-created vault...
    expect(ks.isUnlockedV4()).toBe(true);
    expect(ks.getUnlockedAddressV4()).toBe(addrBefore);
    // ...and nothing was persisted.
    expect(JSON.stringify(storage[KEY])).toBe(before);
  });

  it("a failed vault-select leaves the previously active vault active", async () => {
    await ks.addVaultFreshV4("Wallet 2");
    const activeBefore = ks.getUnlockedAddressV4();
    const vaults = await ks.listVaultsV4();
    const other = vaults!.find((v) => !v.isActive)!;
    failNextSet("I/O error");
    await expect(ks.selectActiveVaultV4(other.id)).rejects.toThrow(/I\/O error/);
    failNextSet(null);
    expect(ks.getUnlockedAddressV4()).toBe(activeBefore);
  });
});

// ---------------------------------------------------------------------------
// H1 — two concurrent container read-modify-writes must BOTH land.
//
// The container is one storage blob and every mutator does load → mutate →
// write-the-whole-blob. Without serialisation two writers both read the same
// prior value and the second clobbers the first. When both writers are
// APPENDING a vault, what is clobbered is a vault record — its wrapped VEK and
// its sealed seed envelope — while its address stays funded on-chain. That is
// the fund-loss pair from the plan, and it is what this block pins.
//
// Modelled on storage-lock.test.ts's "two concurrent writers both land".
// ---------------------------------------------------------------------------

/** Chrome stub that can hold the NEXT `get` open until released, so an
 *  interleaving is deterministic rather than timing-dependent. */
function installGatedChromeStub(): {
  storage: StorageMap;
  gateNextGet: () => { release: () => void };
} {
  const storage: StorageMap = {};
  let gate: Promise<void> | null = null;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {},
    storage: {
      local: {
        get: (keys: string[], cb: (res: Record<string, unknown>) => void) => {
          const held = gate;
          gate = null;
          // Snapshot NOW, deliver later. The real API services the read when it
          // is issued and hands that value to the callback even if a `set`
          // lands in between — which is exactly the stale-snapshot condition
          // under test. Re-reading at delivery time would hand the suspended
          // caller fresh data and the race would silently disappear.
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in storage) out[k] = JSON.parse(JSON.stringify(storage[k]));
          }
          const deliver = () => cb(out);
          if (held) void held.then(deliver);
          else queueMicrotask(deliver);
        },
        set: (entries: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(entries)) {
            storage[k] = JSON.parse(JSON.stringify(v));
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
  return {
    storage,
    gateNextGet: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return { release };
    },
  };
}

describe("concurrent container writers both land (H1)", () => {
  // ONE real Argon2id derivation for the whole block: both writers under test
  // use the cached MEK, so the race itself costs no derivations.
  let ks: typeof import("./keystore-mldsa.js");
  let storage: StorageMap;
  let gateNextGet: () => { release: () => void };
  let KEY: string;

  beforeAll(async () => {
    ({ storage, gateNextGet } = installGatedChromeStub());
    vi.resetModules();
    ks = await import("./keystore-mldsa.js");
    KEY = ks.__internalV4Multi.VAULTS_CONTAINER_KEY_V4;
    await ks.createVaultFromNewMnemonic("correct horse battery staple 42");
  }, 60_000);

  afterAll(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("two interleaved vault-adds both survive — neither record is clobbered", async () => {
    const startCount = (storage[KEY] as { vaults: unknown[] }).vaults.length;

    // Hold the FIRST add's container read open, then start the second and give
    // it a full macrotask turn to get as far as it can while the first is
    // suspended.
    //
    // Deliberately NOT `await second` before releasing: once the writers are
    // serialised the second CANNOT complete while the first holds the lock, so
    // awaiting it first would deadlock the test rather than assert anything.
    // Unserialised, the second runs start-to-finish in that turn and its write
    // lands before the first resumes — which is precisely the losing
    // interleaving this test must reproduce.
    const gate = gateNextGet();
    const first = ks.addVaultFreshV4("Concurrent A");
    const second = ks.addVaultFreshV4("Concurrent B");
    await new Promise((r) => setTimeout(r, 0));
    gate.release();
    await Promise.all([first, second]);

    const labels = (storage[KEY] as { vaults: Array<{ label: string }> }).vaults.map(
      (v) => v.label,
    );
    expect(labels).toContain("Concurrent B");
    expect(labels).toContain("Concurrent A");
    expect(labels.length).toBe(startCount + 2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// D1 — password verification must report WHY it failed.
//
// A bare boolean folded three different outcomes into one `false`: "there is no
// container", "the container has no active vault", and a genuine AEAD failure.
// Callers charge a brute-force attempt on `false`, so the two structural cases
// burned the user's attempts for conditions that never evaluated the password.
// Costs no Argon2id: both structural cases return before the derivation.
// ---------------------------------------------------------------------------
describe("verifyContainerPasswordV4 reports why it failed (D1)", () => {
  let ks: typeof import("./keystore-mldsa.js");
  let storage: StorageMap;

  beforeEach(async () => {
    ({ storage } = installChromeStub());
    vi.resetModules();
    ks = await import("./keystore-mldsa.js");
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("reports a MISSING CONTAINER as structural, not as a wrong password", async () => {
    const r = await ks.verifyContainerPasswordV4("any-password-at-all");
    expect(r.verified).toBe(false);
    expect(r.verified === false && r.structural).toBe(true);
  });

  it("reports a container with a DANGLING activeVaultId as structural", async () => {
    const KEY = ks.__internalV4Multi.VAULTS_CONTAINER_KEY_V4;
    storage[KEY] = {
      version: 5,
      algo: "ml-dsa-65",
      kdf: "argon2id",
      aead: "xchacha20-poly1305",
      masterKdf: { kdf: "argon2id", m: 65536, t: 3, p: 1, salt: "c2FsdA==" },
      vaults: [],
      activeVaultId: "does-not-exist",
    };
    const r = await ks.verifyContainerPasswordV4("any-password-at-all");
    expect(r.verified).toBe(false);
    expect(r.verified === false && r.structural).toBe(true);
  });
});
