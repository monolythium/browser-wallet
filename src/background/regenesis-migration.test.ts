import { afterEach, describe, expect, it } from "vitest";

import {
  isRegenesisSensitiveLocalKey,
  migrateRegenesisSensitiveState,
  TESTNET_IDENTITY_STAMP,
  TESTNET_IDENTITY_STAMP_KEY,
} from "./regenesis-migration";

type StorageMap = Record<string, unknown>;

function installChromeStorage(
  localSeed: StorageMap,
  sessionSeed: StorageMap = {},
): { local: StorageMap; session: StorageMap } {
  const local = structuredClone(localSeed);
  const session = structuredClone(sessionSeed);

  const area = (storage: StorageMap) => ({
    get: (
      keys: string | string[] | null,
      callback: (result: StorageMap) => void,
    ) => {
      if (keys === null) {
        callback(structuredClone(storage));
        return;
      }
      const selected = Array.isArray(keys) ? keys : [keys];
      callback(
        Object.fromEntries(
          selected
            .filter((key) => key in storage)
            .map((key) => [key, structuredClone(storage[key])]),
        ),
      );
    },
    remove: (keys: string | string[], callback: () => void) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete storage[key];
      }
      callback();
    },
    set: (entries: StorageMap, callback: () => void) => {
      Object.assign(storage, structuredClone(entries));
      callback();
    },
  });

  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: area(local),
      session: area(session),
    },
  };
  return { local, session };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("Posture-C re-genesis migration", () => {
  it("binds the migration stamp to the accepted V16 R5 consensus identity", () => {
    expect(TESTNET_IDENTITY_STAMP).toEqual({
      schemaVersion: 0,
      chainId: "0x10f2c",
      genesisHash:
        "0x8dfc309dfe8e35b4ca036631c7dc25b29e618ac8a9694e0e2bbe23d0f98ab1fe",
    });
  });

  it("keeps the deletion boundary explicit and custody-safe", () => {
    expect(isRegenesisSensitiveLocalKey("mono.activity.0xabc.0x10f2c")).toBe(
      true,
    );
    expect(
      isRegenesisSensitiveLocalKey(
        "mono.notifications.incoming-watermark.0xabc.0x10f2c.v1",
      ),
    ).toBe(true);
    expect(isRegenesisSensitiveLocalKey("mono.names.cache")).toBe(true);
    expect(isRegenesisSensitiveLocalKey("mono.ws.lastBlockHex")).toBe(true);

    expect(isRegenesisSensitiveLocalKey("mono.vaults.v4")).toBe(false);
    expect(isRegenesisSensitiveLocalKey("mono.contacts.v1")).toBe(false);
    expect(isRegenesisSensitiveLocalKey("mono.connected-sites")).toBe(false);
    expect(isRegenesisSensitiveLocalKey("mono.chains.user")).toBe(false);
    expect(isRegenesisSensitiveLocalKey("mono.operators.override")).toBe(false);
    expect(
      isRegenesisSensitiveLocalKey("mono.notifications.os-enabled.v1"),
    ).toBe(false);
    expect(isRegenesisSensitiveLocalKey("mono.two-tier-features.v1")).toBe(
      false,
    );
  });

  it("clears predecessor-chain material and stamps the V16 R5 identity", async () => {
    const { local, session } = installChromeStorage(
      {
        "mono.activity.0xabc.0x10f2c": { confirmed: ["old"] },
        "mono.activity.pending.0xabc.0x10f2c": { pending: ["old"] },
        "mono.balance.0xabc.0x10f2c": { balanceHex: "0x1" },
        "mono.notifications.history.0xabc.0x10f2c.v1": {
          entries: ["old"],
        },
        "mono.notifications.notified.0xabc.0x10f2c.v1": { ids: ["old"] },
        "mono.notifications.incoming-watermark.0xabc.0x10f2c.v1": {
          blockHeight: 99,
        },
        "mono.names.cache": { "0xabc": "old" },
        "mono.sent-addrs.0xabc.0x10f2c": ["old"],
        "mono.ws.lastBlockHex": "0x63",
        "mono.vaults.v4": { encrypted: true },
        "mono.contacts.v1": [{ name: "preserved" }],
        "mono.connected-sites": { "https://example.test": true },
        "mono.notifications.os-enabled.v1": true,
        "nonmono.keep": "preserved",
      },
      {
        "mono.nonce.pending": { old: true },
        "mono.session.genesis-cache.v2": { old: true },
        "mono.session.operator.v1": { rpc: "https://old.invalid" },
        "mono.session.passkey-usage.v1": { preserved: true },
      },
    );

    await expect(migrateRegenesisSensitiveState()).resolves.toBe(true);

    expect(local["mono.activity.0xabc.0x10f2c"]).toBeUndefined();
    expect(
      local["mono.notifications.history.0xabc.0x10f2c.v1"],
    ).toBeUndefined();
    expect(local["mono.names.cache"]).toBeUndefined();
    expect(local["mono.ws.lastBlockHex"]).toBeUndefined();
    expect(local["mono.vaults.v4"]).toEqual({ encrypted: true });
    expect(local["mono.contacts.v1"]).toEqual([{ name: "preserved" }]);
    expect(local["mono.connected-sites"]).toEqual({
      "https://example.test": true,
    });
    expect(local["mono.notifications.os-enabled.v1"]).toBe(true);
    expect(local["nonmono.keep"]).toBe("preserved");
    expect(local[TESTNET_IDENTITY_STAMP_KEY]).toEqual(
      TESTNET_IDENTITY_STAMP,
    );

    expect(session["mono.nonce.pending"]).toBeUndefined();
    expect(session["mono.session.genesis-cache.v2"]).toBeUndefined();
    expect(session["mono.session.operator.v1"]).toBeUndefined();
    expect(session["mono.session.passkey-usage.v1"]).toEqual({
      preserved: true,
    });
  });

  it("is a no-op once the exact identity is stamped", async () => {
    const { local, session } = installChromeStorage(
      {
        [TESTNET_IDENTITY_STAMP_KEY]: { ...TESTNET_IDENTITY_STAMP },
        "mono.activity.0xabc.0x10f2c": { confirmed: ["current"] },
      },
      {
        "mono.session.operator.v1": { rpc: "https://current.invalid" },
      },
    );

    await expect(migrateRegenesisSensitiveState()).resolves.toBe(false);
    expect(local["mono.activity.0xabc.0x10f2c"]).toEqual({
      confirmed: ["current"],
    });
    expect(session["mono.session.operator.v1"]).toEqual({
      rpc: "https://current.invalid",
    });
  });

  it("re-runs when a predecessor identity stamp is present", async () => {
    const { local } = installChromeStorage({
      [TESTNET_IDENTITY_STAMP_KEY]: {
        schemaVersion: 0,
        chainId: TESTNET_IDENTITY_STAMP.chainId,
        genesisHash: `0x${"11".repeat(32)}`,
      },
      "mono.activity.0xabc.0x10f2c": { confirmed: ["old"] },
    });

    await expect(migrateRegenesisSensitiveState()).resolves.toBe(true);
    expect(local["mono.activity.0xabc.0x10f2c"]).toBeUndefined();
    expect(local[TESTNET_IDENTITY_STAMP_KEY]).toEqual(
      TESTNET_IDENTITY_STAMP,
    );
  });
});
