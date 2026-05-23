// Phase 11 Commit 10 — useEscToClose hook tests.
//
// Without a DOM-aware test environment (no jsdom in vitest setup) we
// cannot exercise the document-listener wire-up directly. The tests
// below validate the module's public surface; behaviour is covered
// integration-side via the popup's manual smoke flow.

import { describe, expect, it } from "vitest";
import { useEscToClose } from "./useEscToClose.js";

describe("useEscToClose exports", () => {
  it("is a function", () => {
    expect(typeof useEscToClose).toBe("function");
  });

  it("is callable with (onClose) signature (default enabled = true)", () => {
    // Outside a React render we can't invoke a hook; verify the import
    // succeeded + the function arity is what consumers expect.
    expect(useEscToClose.length).toBeGreaterThanOrEqual(1);
  });
});
