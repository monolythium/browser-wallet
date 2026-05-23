// Phase 11 Commit 3 — AddressActivityKind normaliser tests.
//
// The chain emits a typed `lyth_addressActivityKind` response (chain
// commit d77e4fc, SDK @0fd8a79 typed binding). The wallet's normaliser
// translates wire shape (with bigints) into a plain-JSON envelope the
// popup can route through chrome.storage.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVITY_KIND_ENVELOPE,
  activityKindLabel,
  normaliseActivityKind,
  normaliseKindString,
  type WalletActivityKind,
} from "./activity-kind.js";

describe("normaliseKindString", () => {
  it.each([
    ["found", "found"],
    ["not_found", "not_found"],
    ["indexer_disabled", "indexer_disabled"],
    ["pruned", "pruned"],
    ["private", "private"],
  ] as const)("passes known kind %s through", (input, expected) => {
    expect(normaliseKindString(input)).toBe(expected);
  });

  it("collapses an unknown kind to 'unknown'", () => {
    expect(normaliseKindString("future_kind_chain_adds_later")).toBe("unknown");
  });
});

describe("normaliseActivityKind", () => {
  const addr = "0xABCD";

  it("returns null for non-object input", () => {
    expect(normaliseActivityKind(addr, null)).toBeNull();
    expect(normaliseActivityKind(addr, "string")).toBeNull();
    expect(normaliseActivityKind(addr, 42)).toBeNull();
  });

  it("returns null when kind is missing", () => {
    expect(
      normaliseActivityKind(addr, { schemaVersion: 1, address: addr }),
    ).toBeNull();
  });

  it("returns null when kind is not a string", () => {
    expect(
      normaliseActivityKind(addr, { schemaVersion: 1, address: addr, kind: 42 }),
    ).toBeNull();
  });

  it("normalises a found envelope without retention", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 1,
      address: "0xABCD",
      kind: "found",
    });
    expect(env).not.toBeNull();
    expect(env!.kind).toBe("found");
    expect(env!.address).toBe("0xabcd");
    expect(env!.schemaVersion).toBe(1);
    expect(env!.retention).toBeNull();
  });

  it("lowercases the address", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 1,
      address: "0xABCDEF",
      kind: "found",
    });
    expect(env!.address).toBe("0xabcdef");
  });

  it("falls back to the input address when the response omits one", () => {
    const env = normaliseActivityKind("0xWALLET", {
      schemaVersion: 1,
      kind: "found",
    });
    expect(env!.address).toBe("0xwallet");
  });

  it("normalises a pruned envelope with bigint retention to string", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 1,
      address: addr,
      kind: "pruned",
      retention: {
        earliestRetained: 123456n,
      },
    });
    expect(env!.kind).toBe("pruned");
    expect(env!.retention?.earliestRetained).toBe("123456");
    expect(env!.retention?.archiveRedirect).toBeNull();
  });

  it("normalises a pruned envelope with string retention", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 1,
      address: addr,
      kind: "pruned",
      retention: { earliestRetained: "999000" },
    });
    expect(env!.retention?.earliestRetained).toBe("999000");
  });

  it("normalises a pruned envelope with number retention", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 1,
      address: addr,
      kind: "pruned",
      retention: { earliestRetained: 42 },
    });
    expect(env!.retention?.earliestRetained).toBe("42");
  });

  it("preserves archiveRedirect hint when present", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 1,
      address: addr,
      kind: "pruned",
      retention: {
        earliestRetained: 123n,
        archiveRedirect: { hint: "Visit archive.mono.example/wallet/0x..." },
      },
    });
    expect(env!.retention?.archiveRedirect?.hint).toContain("archive.mono");
  });

  it("treats a pruned envelope without earliestRetained as no-retention", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 1,
      address: addr,
      kind: "pruned",
      retention: {},
    });
    expect(env!.kind).toBe("pruned");
    expect(env!.retention).toBeNull();
  });

  it("collapses unknown chain kinds to 'unknown'", () => {
    const env = normaliseActivityKind(addr, {
      schemaVersion: 2,
      address: addr,
      kind: "future_kind_v2",
    });
    expect(env!.kind).toBe("unknown");
  });

  it("defaults schemaVersion to 0 when missing", () => {
    const env = normaliseActivityKind(addr, {
      address: addr,
      kind: "found",
    });
    expect(env!.schemaVersion).toBe(0);
  });
});

describe("DEFAULT_ACTIVITY_KIND_ENVELOPE", () => {
  it("is a safe defensive default — not_found with no retention", () => {
    expect(DEFAULT_ACTIVITY_KIND_ENVELOPE.kind).toBe("not_found");
    expect(DEFAULT_ACTIVITY_KIND_ENVELOPE.retention).toBeNull();
  });
});

describe("activityKindLabel", () => {
  it("returns a non-empty string for every kind", () => {
    const kinds: WalletActivityKind[] = [
      "found",
      "not_found",
      "indexer_disabled",
      "pruned",
      "private",
      "unknown",
    ];
    for (const k of kinds) {
      const label = activityKindLabel(k);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
