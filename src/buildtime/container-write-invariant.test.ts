// H1 — the static assertion behind the container-write invariant.
//
// Every mutation of the v4 vaults container is supposed to go through
// `mutateContainer` or `createContainer`, each of which owns the container lock,
// the read and the write. Before this check that was a convention: correct by
// review, unenforced. A new writer could call `saveVaultsContainerV4` directly —
// with no lock, or holding the lock but persisting a snapshot read before it,
// which is the dangerous one because the lock is visibly present.
//
// The last test in this file applies the assertion to the real keystore module.
// The ones before it pin the analyser itself against synthetic sources, so the
// check is known to FAIL when it should and not merely to pass today. A check
// only ever observed passing is not known to work.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertContainerWritesRouted,
  findRawContainerWrites,
} from "./container-write-invariant";

const KEYSTORE_PATH = new URL(
  "../background/keystore-mldsa.ts",
  import.meta.url,
);

/** A source shaped like the real module: the raw writer's declaration, then a
 *  primitive that calls it, then whatever the caller wants to append. */
function moduleWith(tail: string): string {
  return [
    "async function saveVaultsContainerV4(c: VaultsContainerV4) {",
    "  await chrome.storage.local.set({ key: c });",
    "}",
    "",
    "async function mutateContainer<T>(fn: Fn<T>): Promise<T> {",
    "  return withKeyLock(KEY, async () => {",
    "    const container = await loadVaultsContainerV4();",
    "    await saveVaultsContainerV4(container);",
    "  });",
    "}",
    "",
    tail,
  ].join("\n");
}

describe("findRawContainerWrites — what the analyser treats as an offence", () => {
  it("accepts the primitives' own writes", () => {
    expect(findRawContainerWrites(moduleWith(""))).toEqual([]);
  });

  it("accepts a write inside createContainer", () => {
    const src = moduleWith(
      [
        "async function createContainer<T>(build: Build): Promise<T> {",
        "  return withKeyLock(KEY, async () => {",
        "    await saveVaultsContainerV4(build());",
        "  });",
        "}",
      ].join("\n"),
    );
    expect(findRawContainerWrites(src)).toEqual([]);
  });

  it("REJECTS a direct write from a new writer, naming its line and function", () => {
    const src = moduleWith(
      [
        "export async function renameVaultV4(id: string, label: string) {",
        "  const container = await loadVaultsContainerV4();",
        "  await saveVaultsContainerV4(container);",
        "}",
      ].join("\n"),
    );
    const found = findRawContainerWrites(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      line: 14,
      enclosing: "renameVaultV4",
      text: "await saveVaultsContainerV4(container);",
    });
  });

  it("REJECTS a write that takes the lock but persists a pre-lock snapshot", () => {
    // The dangerous shape: the lock is visibly present, so review reads as fine.
    const src = moduleWith(
      [
        "export async function sneakyV4() {",
        "  const stale = await loadVaultsContainerV4();",
        "  return withKeyLock(KEY, async () => {",
        "    await saveVaultsContainerV4(stale);",
        "  });",
        "}",
      ].join("\n"),
    );
    expect(findRawContainerWrites(src)).toHaveLength(1);
  });

  it("REJECTS a write at top level", () => {
    const src = moduleWith("await saveVaultsContainerV4(someContainer);");
    const found = findRawContainerWrites(src);
    expect(found).toHaveLength(1);
    expect(found[0]?.enclosing).toBeNull();
  });

  it("REJECTS a write inside a top-level arrow const declared after a primitive", () => {
    // The misattribution guard. Without resetting at the column-0 `}`, this call
    // would be credited to `mutateContainer` above it and pass — a false
    // negative on exactly the shape a new writer is likely to take.
    const src = moduleWith(
      [
        "export const writeItV4 = async () => {",
        "  await saveVaultsContainerV4(container);",
        "};",
      ].join("\n"),
    );
    const found = findRawContainerWrites(src);
    expect(found).toHaveLength(1);
    expect(found[0]?.enclosing).toBeNull();
  });

  it("does not flag the raw writer's own declaration", () => {
    expect(findRawContainerWrites(moduleWith(""))).toEqual([]);
  });

  it("does not flag a mention in the test-internal export list", () => {
    const src = moduleWith(
      ["export const __internalV4Multi = {", "  saveVaultsContainerV4,", "};"].join(
        "\n",
      ),
    );
    expect(findRawContainerWrites(src)).toEqual([]);
  });

  it("does not flag a call inside a line comment", () => {
    const src = moduleWith(
      [
        "export async function documentedV4() {",
        "  // await saveVaultsContainerV4(container);",
        "  return mutateContainer((c) => c);",
        "}",
      ].join("\n"),
    );
    expect(findRawContainerWrites(src)).toEqual([]);
  });

  it("does not flag a call named in a doc block", () => {
    const src = moduleWith(
      [
        "/**",
        " * Routes through the primitive rather than calling",
        " * saveVaultsContainerV4(container) directly.",
        " */",
        "export async function documentedV4() {",
        "  return mutateContainer((c) => c);",
        "}",
      ].join("\n"),
    );
    expect(findRawContainerWrites(src)).toEqual([]);
  });
});

describe("assertContainerWritesRouted — the failure message", () => {
  it("names the file, the line, the enclosing function and the rule", () => {
    const src = moduleWith(
      [
        "export async function newWriterV4() {",
        "  await saveVaultsContainerV4(container);",
        "}",
      ].join("\n"),
    );
    let message = "";
    try {
      assertContainerWritesRouted(src, "src/background/keystore-mldsa.ts");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("src/background/keystore-mldsa.ts:13");
    expect(message).toContain("inside `newWriterV4()`");
    expect(message).toContain("mutateContainer");
    expect(message).toContain("createContainer");
    // It must teach the rule, not just report a location.
    expect(message).toContain("Do NOT delete this assertion");
    // And it must state its own residual rather than reading as absolute.
    expect(message).toContain("WHAT THIS CHECK DOES NOT CATCH");
  });

  it("passes silently when every write is routed", () => {
    expect(() =>
      assertContainerWritesRouted(moduleWith(""), "synthetic.ts"),
    ).not.toThrow();
  });
});

describe("the real keystore module", () => {
  it("routes every container write through a mutation primitive", () => {
    const source = readFileSync(KEYSTORE_PATH, "utf8");
    // Assert through the throwing wrapper so a regression surfaces the full
    // explanatory message, not a bare array diff.
    expect(() =>
      assertContainerWritesRouted(source, "src/background/keystore-mldsa.ts"),
    ).not.toThrow();
  });

  it("still contains the raw writer, so the check is inspecting something real", () => {
    // Guards against the check silently passing because the function was renamed
    // out from under it.
    const source = readFileSync(KEYSTORE_PATH, "utf8");
    expect(source).toContain("async function saveVaultsContainerV4(");
  });
});
