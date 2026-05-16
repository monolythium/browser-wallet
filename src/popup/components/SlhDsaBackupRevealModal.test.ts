// Phase 10 Commit 3 — pure-helper tests for the SLH-DSA backup
// reveal modal. The modal's React state machine is not snapshot-
// tested (same posture as Phase 9's PasskeyRegisterModal +
// PasskeySignModal); the manual verification happens in the dev
// popup. This file pins the only piece of pure logic the modal
// exports — `buildDownloadText` — so the downloaded backup file's
// shape can't drift without a loud test failure.

import { describe, expect, it } from "vitest";
import { buildDownloadText } from "./SlhDsaBackupRevealModal.js";

const FIXTURE_MNEMONIC =
  "abandon ability able about above absent absorb abstract " +
  "absurd abuse access accident account accuse achieve acid " +
  "acoustic acquire across act action actor actress actual";

describe("buildDownloadText", () => {
  it("includes the security-warning header", () => {
    const out = buildDownloadText(FIXTURE_MNEMONIC, "mono1abc…xyz");
    expect(out).toContain("Monolythium Wallet");
    expect(out).toContain("DO NOT share");
    expect(out).toContain("Emergency Recovery Backup");
  });

  it("includes the vault address label verbatim", () => {
    const label = "mono1qarstuvwxyz";
    const out = buildDownloadText(FIXTURE_MNEMONIC, label);
    expect(out).toContain(`Vault address: ${label}`);
  });

  it("identifies the algorithm + standard", () => {
    const out = buildDownloadText(FIXTURE_MNEMONIC, "x");
    expect(out).toContain("SLH-DSA-SHA2-128s");
    expect(out).toContain("FIPS 205");
  });

  it("wraps the mnemonic in BEGIN/END markers for easy extraction", () => {
    const out = buildDownloadText(FIXTURE_MNEMONIC, "x");
    expect(out).toContain("----- BEGIN BIP-39 (24 words) -----");
    expect(out).toContain("----- END BIP-39 -----");
    // The mnemonic itself should appear on its own line between the
    // markers.
    const lines = out.split("\n");
    const beginIdx = lines.findIndex((l) =>
      l.startsWith("----- BEGIN BIP-39"),
    );
    const endIdx = lines.findIndex((l) => l.startsWith("----- END BIP-39"));
    expect(beginIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
    expect(lines.slice(beginIdx + 1, endIdx).join("\n")).toBe(
      FIXTURE_MNEMONIC,
    );
  });

  it("emits an ISO timestamp at line 'Created at:'", () => {
    const out = buildDownloadText(FIXTURE_MNEMONIC, "x");
    const match = out.match(/Created at:\s+(\S+)/);
    expect(match).not.toBeNull();
    // ISO 8601 with millisecond precision + Z timezone — what
    // `new Date().toISOString()` returns.
    expect(match![1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("ends with a trailing newline (POSIX text-file convention)", () => {
    const out = buildDownloadText(FIXTURE_MNEMONIC, "x");
    expect(out.endsWith("\n")).toBe(true);
  });
});
