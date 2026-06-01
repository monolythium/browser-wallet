// sessionStorage round-trip for Stake form / selection state.
//
// Stake and ClusterDetail are sibling screens in App.tsx's `screen`
// enum; navigating between them unmounts Stake. The persistence
// helpers in Stake.tsx serialise selection state on every change and
// restore it on the next mount so the user lands back on the same
// cluster + step + amount after returning from ClusterDetail.
//
// vitest runs without a DOM environment so we stub sessionStorage
// here. The stub matches the Web Storage contract narrowly enough for
// the clearStakeState helper's contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface StubStorage {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
  clear: () => void;
}

function makeStubStorage(): StubStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
  };
}

const stub = makeStubStorage();
vi.stubGlobal("sessionStorage", stub);

const { clearStakeState } = await import("./Stake");

const STAKE_STATE_KEY = "monowallet_stake_state";

describe("Stake state persistence (sessionStorage contract)", () => {
  beforeEach(() => {
    stub.clear();
  });

  it("clearStakeState removes the persisted entry", () => {
    stub.setItem(
      STAKE_STATE_KEY,
      JSON.stringify({ step: "pick", selectedClusterId: 0 }),
    );
    expect(stub.getItem(STAKE_STATE_KEY)).not.toBeNull();
    clearStakeState();
    expect(stub.getItem(STAKE_STATE_KEY)).toBeNull();
  });

  it("clearStakeState is idempotent when nothing is stored", () => {
    expect(stub.getItem(STAKE_STATE_KEY)).toBeNull();
    clearStakeState();
    expect(stub.getItem(STAKE_STATE_KEY)).toBeNull();
  });

  it("malformed JSON in the key clears cleanly without throwing", () => {
    stub.setItem(STAKE_STATE_KEY, "not-json-{");
    clearStakeState();
    expect(stub.getItem(STAKE_STATE_KEY)).toBeNull();
  });
});
