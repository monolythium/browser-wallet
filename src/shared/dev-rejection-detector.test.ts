// What the dev rejection detector is allowed to write to the console.
//
// The detector sees rejection reasons, and a rejection reason is arbitrary — a
// caller can reject with anything, including a password, a mnemonic, or a signed
// transaction. So the binding property is NEGATIVE: the diagnostic must be built
// from type names and stack frames, and must never carry a value.
//
// V8 puts the error message on the FIRST line of `.stack`, which makes that line
// the one realistic leak path, so these assertions concentrate there.
//
// Pure-function coverage. Whether the listener is registered, and whether it
// correctly declines to call `preventDefault()`, is not observable here — no DOM
// environment — and is hand-verified.

import { describe, expect, it } from "vitest";

import { formatRejectionDiagnostic } from "./dev-rejection-detector";

/** Stand-ins for the things that must never reach the console. */
const SECRET_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon";
const SECRET_PASSWORD = "hunter2-correct-horse";

describe("the diagnostic never carries the rejection payload", () => {
  it("drops an error message that embeds a password", () => {
    const e = new Error(`unlock failed for password ${SECRET_PASSWORD}`);
    const out = formatRejectionDiagnostic(e);
    expect(out).not.toContain(SECRET_PASSWORD);
    expect(out).not.toContain("unlock failed");
  });

  it("drops an error message that embeds a mnemonic", () => {
    const e = new Error(`could not derive from ${SECRET_MNEMONIC}`);
    expect(formatRejectionDiagnostic(e)).not.toContain("abandon");
  });

  it("keeps the leading stack line out even though .stack begins with it", () => {
    const e = new Error(SECRET_PASSWORD);
    // Precondition: V8 really does put the message in `.stack`. If this stops
    // being true the filter is still correct, but the test would be vacuous.
    expect(e.stack ?? "").toContain(SECRET_PASSWORD);
    expect(formatRejectionDiagnostic(e)).not.toContain(SECRET_PASSWORD);
  });

  it("reads nothing off a rejected plain object", () => {
    const out = formatRejectionDiagnostic({
      password: SECRET_PASSWORD,
      mnemonic: SECRET_MNEMONIC,
    });
    expect(out).not.toContain(SECRET_PASSWORD);
    expect(out).not.toContain("abandon");
    expect(out).not.toContain("password");
    expect(out).toContain("type: Object");
  });

  it("reads nothing off a rejected bare string", () => {
    const out = formatRejectionDiagnostic(SECRET_PASSWORD);
    expect(out).not.toContain(SECRET_PASSWORD);
    expect(out).toContain("type: string");
  });
});

describe("the diagnostic still says enough to find the call site", () => {
  it("names the error type and keeps stack frames", () => {
    const e = new TypeError("boom");
    const out = formatRejectionDiagnostic(e);
    expect(out).toContain("type: TypeError");
    // The frames are the whole point — without them the detector says nothing
    // actionable. This test would catch a filter that stripped everything.
    expect(out).toMatch(/\bat\s/);
  });

  it("caps the frame count so a deep stack stays readable", () => {
    const e = new Error("x");
    e.stack = ["Error: x", ...Array.from({ length: 40 }, (_, i) => `    at f${i} (a.ts:${i}:1)`)].join(
      "\n",
    );
    const frames = formatRejectionDiagnostic(e)
      .split("\n")
      .filter((l) => /\bat\s/.test(l));
    expect(frames).toHaveLength(6);
    expect(frames[0]).toContain("f0");
  });

  it("fails closed on a stack whose format it does not recognise", () => {
    const e = new Error(SECRET_PASSWORD);
    // Firefox-style frames, which the `at ` filter does not match. The safe
    // outcome is to emit no frames, NOT to fall back to raw stack text.
    e.stack = `foo@resource://x.js:1:1\nbar@resource://x.js:2:2`;
    const out = formatRejectionDiagnostic(e);
    expect(out).not.toContain("resource://");
    expect(out).toBe("  type: Error");
  });
});

describe("odd reasons do not break the detector", () => {
  it("handles null, undefined and a null-prototype object", () => {
    expect(formatRejectionDiagnostic(null)).toContain("type: null");
    expect(formatRejectionDiagnostic(undefined)).toContain("type: undefined");
    expect(formatRejectionDiagnostic(Object.create(null))).toContain("type: object");
  });

  it("does not trust a hostile constructor property", () => {
    const out = formatRejectionDiagnostic({ constructor: SECRET_PASSWORD });
    expect(out).not.toContain(SECRET_PASSWORD);
  });
});
