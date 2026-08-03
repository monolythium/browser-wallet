// The shared escape used by the build-time source guards.
//
// WHY THESE ASSERTIONS. Both guards interpolate a constant into a `RegExp`. The
// failure they are exposed to is not a crash — it is a guard that quietly stops
// matching, reporting a clean tree it is no longer inspecting. That failure is
// invisible unless something pins it, so the metacharacter case below is the
// point of this file, and the plain-identifier case is what stops an
// over-eager escape from breaking the match that already works.
//
// The wildcard cases pin the deliberate EXCLUSION rather than an oversight: the
// glob caller translates `*` itself, so escaping it here would break the
// popup-only guard instead of hardening it.

import { describe, expect, it } from "vitest";

import { escapeRegExpExceptWildcard } from "./escape-regexp.js";

/** The identifier the container-write guard actually interpolates today. */
const REAL_IDENTIFIER = "saveVaultsContainerV4";

describe("escapeRegExpExceptWildcard — the match that already works keeps working", () => {
  it("leaves a plain identifier unchanged", () => {
    expect(escapeRegExpExceptWildcard(REAL_IDENTIFIER)).toBe(REAL_IDENTIFIER);
  });

  it("still matches a real call site after escaping", () => {
    const re = new RegExp(`\\b${escapeRegExpExceptWildcard(REAL_IDENTIFIER)}\\s*\\(`);
    expect(re.test("  await saveVaultsContainerV4(container);")).toBe(true);
  });

  it("still refuses a bare mention that is not a call", () => {
    const re = new RegExp(`\\b${escapeRegExpExceptWildcard(REAL_IDENTIFIER)}\\s*\\(`);
    expect(re.test("// see saveVaultsContainerV4 for the invariant")).toBe(false);
  });
});

describe("escapeRegExpExceptWildcard — a metacharacter is matched literally", () => {
  // `$` is the ONE metacharacter a JavaScript identifier can legally contain,
  // so this is the rename that would silently break the guard, not a
  // hypothetical. `save$Vault` unescaped compiles `\bsave$Vault\s*\(`, in which
  // `$` is an end-of-input anchor — it can never match, and the guard goes
  // permanently quiet.
  const RENAMED = "save$Vault";

  it("escapes the metacharacter", () => {
    expect(escapeRegExpExceptWildcard(RENAMED)).toBe("save\\$Vault");
  });

  it("matches the literal identifier rather than reading it as a pattern", () => {
    const re = new RegExp(`\\b${escapeRegExpExceptWildcard(RENAMED)}\\s*\\(`);
    expect(re.test("  await save$Vault(container);")).toBe(true);
  });

  it("escapes every metacharacter the guards could meet", () => {
    expect(escapeRegExpExceptWildcard(".+^${}()|[]\\")).toBe(
      "\\.\\+\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    );
  });
});

describe("escapeRegExpExceptWildcard — the wildcard exclusion is deliberate", () => {
  it("leaves `*` alone, so the glob caller can translate it", () => {
    expect(escapeRegExpExceptWildcard("assets/*")).toBe("assets/*");
  });

  it("leaves `?` alone on the same reasoning", () => {
    expect(escapeRegExpExceptWildcard("a?b")).toBe("a?b");
  });

  it("escapes a dot in the same string it leaves the wildcard in", () => {
    expect(escapeRegExpExceptWildcard("pages.*")).toBe("pages\\.*");
  });
});
