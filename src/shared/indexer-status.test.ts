// Phase 11 Commit 4 — IndexerStatus validator tests.
//
// Closes GAP #18 — the wire shape now carries schemaVersion (chain
// 9d59c3f) + an optional retention envelope (chain 94cf845). Wallet
// translates both into a chrome.storage-safe JSON shape and exposes
// schema-drift detection via `isSchemaDrift`.

import { describe, expect, it } from "vitest";
import {
  WALLET_KNOWN_INDEXER_SCHEMA_VERSION,
  isSchemaDrift,
  validateIndexerStatusWire,
} from "./indexer-status.js";

describe("validateIndexerStatusWire — happy paths", () => {
  it("parses a minimal envelope (currentHeight only)", () => {
    const out = validateIndexerStatusWire({ currentHeight: 100 });
    expect(out).not.toBeNull();
    expect(out!.currentHeight).toBe(100);
    expect(out!.latestHeight).toBeNull();
    expect(out!.schemaVersion).toBe(0);
    expect(out!.retention).toBeNull();
  });

  it("parses currentHeight + latestHeight", () => {
    const out = validateIndexerStatusWire({
      currentHeight: 100,
      latestHeight: 110,
    });
    expect(out!.latestHeight).toBe(110);
  });

  it("parses schemaVersion", () => {
    const out = validateIndexerStatusWire({
      currentHeight: 100,
      schemaVersion: 1,
    });
    expect(out!.schemaVersion).toBe(1);
  });

  it("parses a retention envelope", () => {
    const out = validateIndexerStatusWire({
      currentHeight: 100,
      schemaVersion: 1,
      retention: {
        archive: true,
        retentionBlocks: 50_000,
        archiveRedirect: "Older blocks at archive.example.com",
      },
    });
    expect(out!.retention).not.toBeNull();
    expect(out!.retention!.archive).toBe(true);
    expect(out!.retention!.retentionBlocks).toBe(50_000);
    expect(out!.retention!.archiveRedirect).toBe(
      "Older blocks at archive.example.com",
    );
  });
});

describe("validateIndexerStatusWire — defensive", () => {
  it("returns null for non-object input", () => {
    expect(validateIndexerStatusWire(null)).toBeNull();
    expect(validateIndexerStatusWire("string")).toBeNull();
    expect(validateIndexerStatusWire(42)).toBeNull();
  });

  it("returns null when currentHeight is missing", () => {
    expect(validateIndexerStatusWire({ schemaVersion: 1 })).toBeNull();
  });

  it("returns null when currentHeight is non-finite", () => {
    expect(validateIndexerStatusWire({ currentHeight: NaN })).toBeNull();
    expect(validateIndexerStatusWire({ currentHeight: Infinity })).toBeNull();
  });

  it("returns null when latestHeight is present but malformed", () => {
    expect(
      validateIndexerStatusWire({ currentHeight: 100, latestHeight: NaN }),
    ).toBeNull();
    expect(
      validateIndexerStatusWire({ currentHeight: 100, latestHeight: "x" }),
    ).toBeNull();
  });

  it("treats null latestHeight as absent", () => {
    const out = validateIndexerStatusWire({
      currentHeight: 100,
      latestHeight: null,
    });
    expect(out!.latestHeight).toBeNull();
  });

  it("defaults schemaVersion to 0 when absent or non-number", () => {
    const out1 = validateIndexerStatusWire({ currentHeight: 100 });
    expect(out1!.schemaVersion).toBe(0);
    const out2 = validateIndexerStatusWire({
      currentHeight: 100,
      schemaVersion: "1.0.0",
    });
    expect(out2!.schemaVersion).toBe(0);
  });

  it("parses retention with optional fields missing", () => {
    const out = validateIndexerStatusWire({
      currentHeight: 100,
      retention: {},
    });
    expect(out!.retention).not.toBeNull();
    expect(out!.retention!.archive).toBe(false); // default false
    expect(out!.retention!.retentionBlocks).toBeNull();
    expect(out!.retention!.archiveRedirect).toBeNull();
  });

  it("rejects retention.retentionBlocks when non-finite", () => {
    const out = validateIndexerStatusWire({
      currentHeight: 100,
      retention: { retentionBlocks: NaN },
    });
    expect(out!.retention!.retentionBlocks).toBeNull();
  });
});

describe("isSchemaDrift", () => {
  it("returns false when chain matches wallet's known schema", () => {
    expect(isSchemaDrift(WALLET_KNOWN_INDEXER_SCHEMA_VERSION)).toBe(false);
  });

  it("returns false when chain is older than wallet's known schema", () => {
    expect(isSchemaDrift(WALLET_KNOWN_INDEXER_SCHEMA_VERSION - 1)).toBe(false);
    expect(isSchemaDrift(0)).toBe(false);
  });

  it("returns true when chain is newer than wallet's known schema", () => {
    expect(isSchemaDrift(WALLET_KNOWN_INDEXER_SCHEMA_VERSION + 1)).toBe(true);
    expect(isSchemaDrift(WALLET_KNOWN_INDEXER_SCHEMA_VERSION + 10)).toBe(true);
  });
});
