// ErrorBoundary tests.
//
// React class-component error boundaries cannot be reasonably exercised
// without a renderer. We validate the static `getDerivedStateFromError`
// reducer + the public construction surface — the parts that pure
// functions can verify.

import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

describe("ErrorBoundary", () => {
  it("exports a class with the standard React API", () => {
    expect(typeof ErrorBoundary).toBe("function");
    // Class components have a prototype.render method.
    expect(typeof (ErrorBoundary.prototype as { render?: unknown }).render).toBe(
      "function",
    );
  });

  it("getDerivedStateFromError captures the error into state", () => {
    const err = new Error("boom");
    const nextState = (
      ErrorBoundary as unknown as {
        getDerivedStateFromError: (e: Error) => { error: Error | null };
      }
    ).getDerivedStateFromError(err);
    expect(nextState).toEqual({ error: err });
  });
});
