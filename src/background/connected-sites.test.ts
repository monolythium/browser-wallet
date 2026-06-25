import { afterEach, describe, expect, it } from "vitest";

import { loadConnectedSites } from "./connected-sites.js";
import { STORAGE_KEY_CONNECTED_SITES } from "../shared/constants.js";

function installStorage(data: Record<string, unknown>): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (_key: string, cb: (res: Record<string, unknown>) => void) => {
          cb({ [STORAGE_KEY_CONNECTED_SITES]: data });
        },
      },
    },
  };
}

describe("loadConnectedSites — origin-key validation (P4-006)", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("keeps canonical http(s) origins, drops corrupt/hostile keys on load", async () => {
    const good = { address: "0xabc", approvedAt: 1 };
    installStorage({
      "https://good.example": good,
      "http://localhost:8545": { address: "0xdef", approvedAt: 2 },
      "": { address: "0x1", approvedAt: 3 }, // empty key
      "javascript:void(0)": { address: "0x2", approvedAt: 4 }, // bad scheme
      "https://h.example/path": { address: "0x3", approvedAt: 5 }, // pathful, not a canonical origin
      "not a url": { address: "0x4", approvedAt: 6 }, // unparseable
    });
    const out = await loadConnectedSites();
    expect(Object.keys(out).sort()).toEqual([
      "http://localhost:8545",
      "https://good.example",
    ]);
    expect(out["https://good.example"]).toEqual(good);
    expect(out[""]).toBeUndefined();
    expect(out["javascript:void(0)"]).toBeUndefined();
    expect(out["https://h.example/path"]).toBeUndefined();
    expect(out["not a url"]).toBeUndefined();
  });

  it("still drops a value-shape mismatch (existing behavior preserved)", async () => {
    installStorage({
      "https://good.example": { address: "0xabc", approvedAt: 1 },
      "https://bad-value.example": { address: 123 }, // address not a string + no approvedAt
    });
    const out = await loadConnectedSites();
    expect(Object.keys(out)).toEqual(["https://good.example"]);
  });
});
