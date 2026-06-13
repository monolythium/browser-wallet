// ErrorBoundary tests.
//
// React class-component error boundaries cannot be reasonably exercised
// without a renderer. We validate the static `getDerivedStateFromError`
// reducer + the public construction surface — the parts that pure
// functions can verify — plus the #38 developer-mode gate on the
// error.stack info-leak surface (buildErrorReport + the presentational
// FallbackCard, which is hook-free and renders to static markup).

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ErrorBoundary,
  FallbackCard,
  buildErrorReport,
} from "./ErrorBoundary.js";

const STACK_MARKER = "SECRET_STACK_MARKER at internal/keystore.ts:42";

function errWithStack(): Error {
  const e = new Error("boom");
  e.stack = STACK_MARKER;
  return e;
}

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

describe("ErrorBoundary #38 — stack gated behind developer mode", () => {
  it("buildErrorReport omits the stack when dev-mode is OFF", () => {
    const report = buildErrorReport(errWithStack(), false);
    expect(report).toContain("Error: boom");
    expect(report).not.toContain(STACK_MARKER);
  });

  it("buildErrorReport includes the stack when dev-mode is ON", () => {
    const report = buildErrorReport(errWithStack(), true);
    expect(report).toContain("Error: boom");
    expect(report).toContain(STACK_MARKER);
  });

  it("FallbackCard hides the stack in the UI when dev-mode is OFF", () => {
    const markup = renderToStaticMarkup(
      createElement(FallbackCard, {
        error: errWithStack(),
        onReset: () => {},
        devMode: false,
      }),
    );
    // name + message + reassurance still shown; stack is not.
    expect(markup).toContain("boom");
    expect(markup).toContain("Something went wrong");
    expect(markup).not.toContain(STACK_MARKER);
  });

  it("FallbackCard shows the stack in the UI when dev-mode is ON", () => {
    const markup = renderToStaticMarkup(
      createElement(FallbackCard, {
        error: errWithStack(),
        onReset: () => {},
        devMode: true,
      }),
    );
    expect(markup).toContain(STACK_MARKER);
  });
});
