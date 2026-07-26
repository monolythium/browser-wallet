// Guards the operator display-name fallback.
//
// The load-bearing case is the last one: a user-added operator must never be
// relabelled. The label is keyed on the pinned official host AND on the name
// still being a wallet-minted `operator-N` placeholder, so a user's own name
// survives even when they point at the official gateway.

import { describe, expect, it } from "vitest";

import { getRpcEndpoints } from "@monolythium/core-sdk";

import {
  PINNED_GATEWAY_LABEL,
  operatorDisplayName,
} from "./operator-display.js";

// Read the pinned host out of the registry rather than restating it, so this
// test follows a registry bump instead of pinning a stale endpoint.
const OFFICIAL = getRpcEndpoints("testnet-69420").find(
  (e) => e.tier === "official",
);
const OFFICIAL_URL = OFFICIAL?.url ?? "";

describe("operatorDisplayName", () => {
  it("has an official pinned endpoint to exercise", () => {
    expect(OFFICIAL_URL).toMatch(/^https?:\/\//);
  });

  it("labels the pinned gateway when the name is a wallet placeholder", () => {
    expect(operatorDisplayName("operator-1", OFFICIAL_URL)).toBe(
      PINNED_GATEWAY_LABEL,
    );
  });

  it("labels the pinned gateway regardless of the placeholder's number", () => {
    // The number is a list position; the label must not depend on it.
    expect(operatorDisplayName("operator-7", OFFICIAL_URL)).toBe(
      PINNED_GATEWAY_LABEL,
    );
  });

  it("labels the pinned gateway when the name is blank", () => {
    expect(operatorDisplayName("", OFFICIAL_URL)).toBe(PINNED_GATEWAY_LABEL);
  });

  it("passes a real registry name through unchanged", () => {
    // If the registry ever carries a real name, it wins — no code removal.
    expect(operatorDisplayName("Frankfurt Gateway", OFFICIAL_URL)).toBe(
      "Frankfurt Gateway",
    );
  });

  it("passes an unknown host through unchanged", () => {
    expect(operatorDisplayName("operator-1", "https://rpc.example.invalid")).toBe(
      "operator-1",
    );
  });

  it("never relabels a user-added operator on its own host", () => {
    expect(operatorDisplayName("My home node", "http://127.0.0.1:8545")).toBe(
      "My home node",
    );
  });

  it("never relabels a user-added operator pointed at the official host", () => {
    // The load-bearing case: same host as the pinned gateway, but the user
    // named it, so the name is not a placeholder and must survive.
    expect(operatorDisplayName("My gateway", OFFICIAL_URL)).toBe("My gateway");
  });

  it("matches the pinned host irrespective of path, case, or scheme noise", () => {
    const host = new URL(OFFICIAL_URL).host;
    expect(operatorDisplayName("operator-1", `https://${host.toUpperCase()}/`)).toBe(
      PINNED_GATEWAY_LABEL,
    );
  });

  it("passes a malformed rpc through unchanged", () => {
    expect(operatorDisplayName("operator-1", "not-a-url")).toBe("operator-1");
  });

  it("does not label a different host that merely ends with the pinned host", () => {
    // Substring matching would relabel an attacker-ish lookalike; host
    // equality must be exact.
    const host = new URL(OFFICIAL_URL).host;
    expect(operatorDisplayName("operator-1", `https://evil-${host}`)).toBe(
      "operator-1",
    );
  });
});
