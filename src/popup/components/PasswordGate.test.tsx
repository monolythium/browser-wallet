// PasswordGate — the four-branch error mapping and the rendered shell.
//
// This codebase has no jsdom and no @testing-library (every component test
// uses renderToStaticMarkup from react-dom/server), so interaction cannot be
// asserted here: typing, Enter-key routing, the submit guard, and the unmount
// clear are NOT covered by these tests and are not claimed to be. What IS
// covered is the part that carries the logic — the pure branch table, which is
// exported precisely so it can be tested without a DOM — plus a static render
// proving the field, the countdown copy, and the submit chrome are wired.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PasswordGate,
  passwordGateErrorFor,
  passwordGateErrorText,
} from "./PasswordGate";

const FALLBACK = "Could not verify password.";

describe("passwordGateErrorFor — the four-branch mapping", () => {
  it("branch 1: rate_limited reports the countdown and arms it", () => {
    expect(
      passwordGateErrorFor(
        { ok: false, reason: "rate_limited", secondsRemaining: 30 },
        FALLBACK,
      ),
    ).toEqual({
      message: "Too many attempts. Try again in 30s.",
      secondsRemaining: 30,
    });
  });

  it("branch 2: wrong_password WITH a lockout names the lock window", () => {
    expect(
      passwordGateErrorFor(
        { ok: false, reason: "wrong_password", secondsRemaining: 30 },
        FALLBACK,
      ),
    ).toEqual({
      message: "Wrong password. Locked for 30s.",
      secondsRemaining: 30,
    });
  });

  it("branch 3: wrong_password with NO lockout is the bare message", () => {
    expect(
      passwordGateErrorFor(
        { ok: false, reason: "wrong_password", secondsRemaining: 0 },
        FALLBACK,
      ),
    ).toEqual({ message: "Wrong password.", secondsRemaining: 0 });
  });

  it("branch 3: a missing secondsRemaining is treated as no lockout", () => {
    expect(
      passwordGateErrorFor({ ok: false, reason: "wrong_password" }, FALLBACK),
    ).toEqual({ message: "Wrong password.", secondsRemaining: 0 });
  });

  it("branch 4: an unmapped reason is surfaced verbatim, with no countdown", () => {
    expect(
      passwordGateErrorFor(
        { ok: false, reason: "cannot remove the last vault" },
        FALLBACK,
      ),
    ).toEqual({
      message: "cannot remove the last vault",
      secondsRemaining: 0,
    });
  });

  it("branch 4: a structural refusal never starts a countdown, even if the reply carries seconds", () => {
    // A refusal is not a failed password attempt — it must not look like one,
    // and it must not disable the field behind a timer the user cannot clear.
    const r = passwordGateErrorFor(
      { ok: false, reason: "container is locked", secondsRemaining: 30 },
      FALLBACK,
    );
    expect(r.secondsRemaining).toBe(0);
    expect(r.message).toBe("container is locked");
  });

  it("branch 4: no reason at all falls back to the caller's string", () => {
    expect(passwordGateErrorFor({ ok: false }, FALLBACK)).toEqual({
      message: FALLBACK,
      secondsRemaining: 0,
    });
  });
});

describe("passwordGateErrorText — what actually renders", () => {
  it("a live countdown supersedes the stored message", () => {
    expect(passwordGateErrorText("Wrong password. Locked for 30s.", 12)).toBe(
      "Too many attempts. Try again in 12s.",
    );
  });

  it("with no countdown the stored message shows through", () => {
    expect(passwordGateErrorText("Wrong password.", 0)).toBe("Wrong password.");
  });

  it("renders nothing when there is nothing to say", () => {
    expect(passwordGateErrorText(null, 0)).toBeNull();
  });
});

describe("PasswordGate — rendered shell", () => {
  const noop = () => {};
  const neverVerifies = async () => ({ ok: false as const });

  it("renders the prompt, a current-password field, and the submit", () => {
    const html = renderToStaticMarkup(
      <PasswordGate
        prompt="Enter your password to view your 24-word recovery phrase."
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
      />,
    );
    expect(html).toContain(
      "Enter your password to view your 24-word recovery phrase.",
    );
    // Reuses the shared PasswordInput, so the NIST autocomplete hint and the
    // masked type come along rather than being hand-rolled. Matched
    // case-insensitively: react-dom 19's static renderer emits the attribute
    // name case-preserved (`autoComplete`), and HTML attribute names are
    // case-insensitive, so pinning the exact casing would assert a renderer
    // detail rather than the behaviour.
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain('type="password"');
    expect(html).toContain("Continue");
  });

  it("submits disabled on first paint — an empty password can never be sent", () => {
    const html = renderToStaticMarkup(
      <PasswordGate
        prompt="Confirm your password to start the reset flow."
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
      />,
    );
    expect(html).toContain("disabled");
  });

  it("omits Cancel unless the caller wants the two-button footer", () => {
    const single = renderToStaticMarkup(
      <PasswordGate
        prompt="p"
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
      />,
    );
    expect(single).not.toContain(">Cancel<");

    const paired = renderToStaticMarkup(
      <PasswordGate
        prompt="p"
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
        onCancel={noop}
      />,
    );
    expect(paired).toContain(">Cancel<");
  });

  it("defaults to the full-screen shell — the page footer, not a modal row", () => {
    const html = renderToStaticMarkup(
      <PasswordGate
        prompt="p"
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
      />,
    );
    expect(html).toContain('class="req-foot"');
    expect(html).toContain('class="prim"');
  });

  it("inline drops the page chrome but keeps the same field", () => {
    const html = renderToStaticMarkup(
      <PasswordGate
        variant="inline"
        prompt="Confirm your password to remove this wallet."
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
      />,
    );
    // req-foot pins itself to the page bottom; inside a Modal that is wrong.
    expect(html).not.toContain('class="req-foot"');
    expect(html).not.toContain('class="prim"');
    // Same prompt, same field, same submit copy — only the chrome changed.
    expect(html).toContain("Confirm your password to remove this wallet.");
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain('type="password"');
    expect(html).toContain("Continue");
  });

  it("inline still starts disabled and still offers Cancel when asked", () => {
    const html = renderToStaticMarkup(
      <PasswordGate
        variant="inline"
        prompt="p"
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain(">Cancel<");
  });

  it("carries no password value into the markup", () => {
    // Belt-and-braces: the field starts empty, so a server-rendered gate can
    // never ship a secret in its HTML.
    const html = renderToStaticMarkup(
      <PasswordGate
        prompt="p"
        fallbackError={FALLBACK}
        verify={neverVerifies}
        onVerified={noop}
      />,
    );
    expect(html).toContain('value=""');
  });
});
