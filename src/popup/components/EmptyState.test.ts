// EmptyState + LoadingState primitive tests.
//
// We don't run React rendering in vitest (no jsdom/JSDOM-aware setup
// today). Instead, validate that the modules export the expected names
// + accept the documented prop shapes via type-only assertions.

import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState.js";
import { InlineSpinner, LoadingState } from "./LoadingState.js";

describe("EmptyState exports", () => {
  it("exports a component function", () => {
    expect(typeof EmptyState).toBe("function");
  });

  it("accepts the documented prop shape (type-level smoke)", () => {
    // The compiler enforces the shape; this just locks the constructor
    // call so an accidental rename of EmptyStateProps surfaces here.
    const _info = EmptyState({ title: "no items" });
    const _warn = EmptyState({ kind: "warn", title: "warning", body: "x" });
    const _withCta = EmptyState({
      kind: "err",
      title: "failed",
      cta: { label: "Retry", onClick: () => undefined },
    });
    expect(_info).toBeDefined();
    expect(_warn).toBeDefined();
    expect(_withCta).toBeDefined();
  });
});

describe("LoadingState exports", () => {
  it("exports both LoadingState and InlineSpinner", () => {
    expect(typeof LoadingState).toBe("function");
    expect(typeof InlineSpinner).toBe("function");
  });

  it("LoadingState accepts default and override labels", () => {
    const _default = LoadingState({});
    const _override = LoadingState({ label: "Fetching delegations…", paddingY: 24 });
    expect(_default).toBeDefined();
    expect(_override).toBeDefined();
  });

  it("InlineSpinner accepts default + custom size", () => {
    const _default = InlineSpinner({});
    const _custom = InlineSpinner({ size: 18 });
    expect(_default).toBeDefined();
    expect(_custom).toBeDefined();
  });
});
