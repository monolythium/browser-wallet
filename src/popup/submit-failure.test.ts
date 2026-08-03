// What a failed submit is allowed to TELL the user.
//
// The defect these guard against: a dropped popup↔SW channel was rendering
// nothing at all. The fix renders something — so the risk moves to rendering the
// WRONG thing. The most dangerous wrong thing is a reassurance: "nothing was
// sent" is false when the worker may have broadcast and died before replying,
// and it is exactly the sentence that would talk a user into a second submit.
//
// These are pure-function assertions. They cover the classification only. Whether
// each component RENDERS the result is not observable here — there is no DOM
// environment in this suite — and is hand-verified.

import { describe, expect, it } from "vitest";

import { submitThrowFailure, verbatimFailure } from "./submit-failure";

// The literal strings Chrome puts on the rejection when the MV3 service worker
// is asleep or torn down mid-message. Written out rather than imported from the
// marker list so the test fails if the markers stop matching reality.
const CHROME_SW_ERRORS = [
  "Could not establish connection. Receiving end does not exist.",
  "The message port closed before a response was received.",
  "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
  "No SW",
];

describe("a dropped popup↔SW channel is reported as UNKNOWN, not as a failure", () => {
  for (const message of CHROME_SW_ERRORS) {
    it(`classifies "${message.slice(0, 40)}…" as indeterminate`, () => {
      expect(submitThrowFailure(new Error(message)).kind).toBe(
        "sw-transport-indeterminate",
      );
    });
  }

  it("NEVER claims nothing was sent — the worker may have broadcast and died", () => {
    for (const message of CHROME_SW_ERRORS) {
      const body = submitThrowFailure(new Error(message)).body.toLowerCase();
      expect(body).not.toContain("nothing was sent");
      expect(body).not.toContain("funds are safe");
      expect(body).not.toContain("funds are unaffected");
    }
  });

  it("tells the user the outcome is unknown and that a retry may double-submit", () => {
    const { headline, body } = submitThrowFailure(
      new Error("Could not establish connection. Receiving end does not exist."),
    );
    expect(headline).not.toBeNull();
    expect(body.toLowerCase()).toContain("can't tell whether this was sent");
    expect(body.toLowerCase()).toContain("a second time");
  });

  it("is NOT mistaken for operator-offline, whose copy promises nothing was sent", () => {
    // The trap: operator-offline is the nearest-looking kind, and its body says
    // "Your funds are safe and nothing was sent." Routing an MV3 teardown there
    // would be a false reassurance on the exact path where a retry can spend
    // twice.
    for (const message of CHROME_SW_ERRORS) {
      expect(submitThrowFailure(new Error(message)).kind).not.toBe("operator-offline");
    }
  });
});

describe("a throw that reached us THROUGH a working worker still classifies normally", () => {
  it("separates a network-transport failure (nothing sent) from the SW drop", () => {
    const r = submitThrowFailure(new Error("no operator reachable"));
    expect(r.kind).toBe("operator-offline");
    // This one CAN promise it: the SW ran, tried every operator, and reported.
    expect(r.body.toLowerCase()).toContain("nothing was sent");
  });

  it("separates a chain rejection from both", () => {
    expect(submitThrowFailure(new Error("insufficient funds for transfer")).kind).toBe(
      "insufficient-funds",
    );
    expect(submitThrowFailure(new Error("execution reverted")).kind).toBe(
      "transaction-reverted",
    );
  });

  it("survives a non-Error throw without losing the surface", () => {
    expect(submitThrowFailure("boom").headline).not.toBeNull();
    expect(submitThrowFailure(undefined).headline).not.toBeNull();
    expect(submitThrowFailure({ nope: true }).headline).not.toBeNull();
  });
});

describe("an { ok: false } reply is still rendered exactly as before", () => {
  it("renders the service worker's reason verbatim with no added headline", () => {
    const r = verbatimFailure("That name is already registered.", "Registration failed.");
    expect(r).toEqual({
      kind: "verbatim",
      headline: null,
      body: "That name is already registered.",
    });
  });

  it("falls back only when the reply carried no usable reason", () => {
    expect(verbatimFailure(undefined, "Registration failed.").body).toBe(
      "Registration failed.",
    );
    expect(verbatimFailure(null, "Registration failed.").body).toBe("Registration failed.");
    expect(verbatimFailure("   ", "Registration failed.").body).toBe("Registration failed.");
  });
});
