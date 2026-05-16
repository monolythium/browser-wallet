// Phase 9 — unit tests for the passkey policy pure helpers.
//
// Every test here pins time, fakes credentials, and never touches
// `navigator.credentials` or `chrome.storage`. The WebAuthn round-trip
// is tested at the IPC layer (Commit 2+); this file validates the
// pure logic that backs the IPC boundary.

import { describe, it, expect } from "vitest";
import {
  DAILY_CAP_WINDOW_MS,
  DEFAULT_PASSKEY_DAILY_CAP_WEI,
  DEFAULT_PASSKEY_LIMIT_WEI,
  MAX_CREDENTIALS_PER_VAULT,
  MAX_PASSKEY_LIMIT_WEI,
  MIN_PASSKEY_LIMIT_WEI,
  appendCredential,
  buildPasskeyChallenge,
  defaultPasskeyPolicy,
  emptyVaultPasskeyState,
  evaluatePolicy,
  pruneUsage,
  removeCredential,
  setPolicy,
  sumUsage,
  validateCredentialName,
  validatePasskeyPolicy,
  type PasskeyCredential,
} from "./passkey.js";

function fakeCred(
  i: number,
  kind: "platform" | "cross-platform" = "platform",
): PasskeyCredential {
  return {
    credentialId: `cred-${i}`,
    name: `Cred ${i}`,
    kind,
    createdAt: 1_000_000 + i,
  };
}

describe("defaultPasskeyPolicy", () => {
  it("starts disabled with per-tx mode + sane defaults", () => {
    const p = defaultPasskeyPolicy();
    expect(p.enabled).toBe(false);
    expect(p.mode).toBe("per-tx");
    expect(p.limitWei).toBe(DEFAULT_PASSKEY_LIMIT_WEI);
    expect(p.dailyCapWei).toBe(DEFAULT_PASSKEY_DAILY_CAP_WEI);
  });

  it("default daily cap is at least the per-tx limit (passes validation)", () => {
    const p = defaultPasskeyPolicy();
    expect(validatePasskeyPolicy(p)).toBeNull();
  });
});

describe("validatePasskeyPolicy", () => {
  it("rejects per-tx limit below the floor", () => {
    const p = { ...defaultPasskeyPolicy(), limitWei: 0n };
    expect(validatePasskeyPolicy(p)).toBe("limit-below-floor");
  });

  it("rejects per-tx limit above the ceiling", () => {
    const p = { ...defaultPasskeyPolicy(), limitWei: MAX_PASSKEY_LIMIT_WEI + 1n };
    expect(validatePasskeyPolicy(p)).toBe("limit-above-ceiling");
  });

  it("rejects daily cap below the per-tx limit", () => {
    const p = {
      ...defaultPasskeyPolicy(),
      limitWei: 5n * MIN_PASSKEY_LIMIT_WEI,
      dailyCapWei: 2n * MIN_PASSKEY_LIMIT_WEI,
    };
    expect(validatePasskeyPolicy(p)).toBe("daily-cap-below-per-tx");
  });

  it("rejects daily cap above the ceiling", () => {
    const p = {
      ...defaultPasskeyPolicy(),
      dailyCapWei: MAX_PASSKEY_LIMIT_WEI + 1n,
    };
    expect(validatePasskeyPolicy(p)).toBe("daily-cap-above-ceiling");
  });

  it("accepts a well-formed policy at the floor", () => {
    const p = {
      enabled: true,
      mode: "per-tx" as const,
      limitWei: MIN_PASSKEY_LIMIT_WEI,
      dailyCapWei: MIN_PASSKEY_LIMIT_WEI,
    };
    expect(validatePasskeyPolicy(p)).toBeNull();
  });
});

describe("validateCredentialName", () => {
  it("rejects empty + whitespace-only names", () => {
    expect(validateCredentialName("")).toBe(false);
    expect(validateCredentialName("   ")).toBe(false);
  });

  it("rejects > 64 chars after trim", () => {
    expect(validateCredentialName("x".repeat(65))).toBe(false);
  });

  it("accepts a reasonable name", () => {
    expect(validateCredentialName("Office YubiKey")).toBe(true);
  });
});

describe("appendCredential", () => {
  it("appends to an empty state", () => {
    const s0 = emptyVaultPasskeyState();
    const s1 = appendCredential(s0, fakeCred(1));
    expect(s1.credentials.length).toBe(1);
    expect(s1.credentials[0]!.name).toBe("Cred 1");
    // policy untouched
    expect(s1.policy).toEqual(s0.policy);
  });

  it("trims the credential name on insert", () => {
    const s0 = emptyVaultPasskeyState();
    const s1 = appendCredential(s0, { ...fakeCred(1), name: "  My Key  " });
    expect(s1.credentials[0]!.name).toBe("My Key");
  });

  it("rejects when the credential cap is hit", () => {
    let s = emptyVaultPasskeyState();
    for (let i = 0; i < MAX_CREDENTIALS_PER_VAULT; i++) {
      s = appendCredential(s, fakeCred(i));
    }
    expect(() => appendCredential(s, fakeCred(99))).toThrow(/cap reached/);
  });

  it("rejects duplicate credentialId", () => {
    const s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    expect(() =>
      appendCredential(s, { ...fakeCred(2), credentialId: "cred-1" }),
    ).toThrow(/duplicate/);
  });

  it("rejects invalid names without mutating state", () => {
    const s = emptyVaultPasskeyState();
    expect(() =>
      appendCredential(s, { ...fakeCred(1), name: "" }),
    ).toThrow(/invalid credential name/);
    expect(s.credentials).toEqual([]);
  });
});

describe("removeCredential", () => {
  it("removes the targeted credential and is a no-op if absent", () => {
    let s = emptyVaultPasskeyState();
    s = appendCredential(s, fakeCred(1));
    s = appendCredential(s, fakeCred(2));
    const s2 = removeCredential(s, "cred-1");
    expect(s2.credentials.map((c) => c.credentialId)).toEqual(["cred-2"]);
    const s3 = removeCredential(s2, "missing");
    expect(s3).toBe(s2);
  });

  it("disables the policy when the last credential is removed", () => {
    let s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    s = setPolicy(s, { ...s.policy, enabled: true });
    expect(s.policy.enabled).toBe(true);
    const s2 = removeCredential(s, "cred-1");
    expect(s2.credentials).toEqual([]);
    expect(s2.policy.enabled).toBe(false);
  });

  it("preserves the policy when at least one credential remains", () => {
    let s = emptyVaultPasskeyState();
    s = appendCredential(s, fakeCred(1));
    s = appendCredential(s, fakeCred(2));
    s = setPolicy(s, { ...s.policy, enabled: true });
    const s2 = removeCredential(s, "cred-1");
    expect(s2.policy.enabled).toBe(true);
  });
});

describe("setPolicy", () => {
  it("rejects an invalid policy without mutating state", () => {
    const s = emptyVaultPasskeyState();
    expect(() =>
      setPolicy(s, { ...s.policy, limitWei: 0n }),
    ).toThrow(/invalid policy/);
    expect(s.policy).toEqual(defaultPasskeyPolicy());
  });

  it("accepts a valid policy and returns a fresh state", () => {
    const s = emptyVaultPasskeyState();
    const s2 = setPolicy(s, { ...s.policy, enabled: true });
    expect(s2.policy.enabled).toBe(true);
    expect(s.policy.enabled).toBe(false);
  });
});

describe("pruneUsage + sumUsage", () => {
  const now = 10_000_000;
  it("drops entries older than the 24h window", () => {
    const entries = [
      { at: now - DAILY_CAP_WINDOW_MS - 1, valueWei: 1n },
      { at: now - DAILY_CAP_WINDOW_MS, valueWei: 2n },
      { at: now - 1, valueWei: 3n },
      { at: now, valueWei: 4n },
    ];
    const pruned = pruneUsage(entries, now);
    // boundary inclusion: `at >= cutoff` keeps exactly-at-the-edge
    expect(pruned.map((e) => e.valueWei)).toEqual([2n, 3n, 4n]);
  });

  it("sums in-window entries", () => {
    const pruned = pruneUsage(
      [
        { at: now - 1000, valueWei: 5n },
        { at: now - 500, valueWei: 7n },
      ],
      now,
    );
    expect(sumUsage(pruned)).toBe(12n);
  });
});

describe("evaluatePolicy", () => {
  const now = 1_000_000;

  it("falls back to password when policy is disabled", () => {
    const s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    expect(
      evaluatePolicy({
        state: s,
        valueWei: 1n,
        recentUsage: [],
        now,
      }),
    ).toEqual({ kind: "password-required", reason: "disabled" });
  });

  it("falls back to password when no credential is registered", () => {
    const s = setPolicy(emptyVaultPasskeyState(), {
      ...defaultPasskeyPolicy(),
      enabled: true,
    });
    expect(
      evaluatePolicy({
        state: s,
        valueWei: 1n,
        recentUsage: [],
        now,
      }).kind,
    ).toBe("password-required");
  });

  it("per-tx: allows below the threshold", () => {
    let s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    s = setPolicy(s, { ...s.policy, enabled: true });
    const d = evaluatePolicy({
      state: s,
      valueWei: DEFAULT_PASSKEY_LIMIT_WEI - 1n,
      recentUsage: [],
      now,
    });
    expect(d.kind).toBe("passkey-ok");
  });

  it("per-tx: at exactly the threshold is OK (<= semantics)", () => {
    let s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    s = setPolicy(s, { ...s.policy, enabled: true });
    const d = evaluatePolicy({
      state: s,
      valueWei: DEFAULT_PASSKEY_LIMIT_WEI,
      recentUsage: [],
      now,
    });
    expect(d.kind).toBe("passkey-ok");
  });

  it("per-tx: rejects above the threshold with attempted+threshold reported", () => {
    let s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    s = setPolicy(s, { ...s.policy, enabled: true });
    const d = evaluatePolicy({
      state: s,
      valueWei: DEFAULT_PASSKEY_LIMIT_WEI + 1n,
      recentUsage: [],
      now,
    });
    expect(d).toEqual({
      kind: "over-limit",
      mode: "per-tx",
      threshold: DEFAULT_PASSKEY_LIMIT_WEI,
      attempted: DEFAULT_PASSKEY_LIMIT_WEI + 1n,
    });
  });

  it("daily: allows when used + value stays within the cap", () => {
    let s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    s = setPolicy(s, {
      ...s.policy,
      enabled: true,
      mode: "daily",
      dailyCapWei: 100n * MIN_PASSKEY_LIMIT_WEI,
    });
    const d = evaluatePolicy({
      state: s,
      valueWei: 10n * MIN_PASSKEY_LIMIT_WEI,
      recentUsage: [
        { at: now - 1000, valueWei: 30n * MIN_PASSKEY_LIMIT_WEI },
        { at: now - 500, valueWei: 20n * MIN_PASSKEY_LIMIT_WEI },
      ],
      now,
    });
    expect(d.kind).toBe("passkey-ok");
  });

  it("daily: rejects when projected total exceeds the cap", () => {
    let s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    s = setPolicy(s, {
      ...s.policy,
      enabled: true,
      mode: "daily",
      // Keep limitWei ≤ dailyCapWei to satisfy validation; we're
      // testing the daily-window arithmetic, not per-tx semantics.
      limitWei: 10n * MIN_PASSKEY_LIMIT_WEI,
      dailyCapWei: 50n * MIN_PASSKEY_LIMIT_WEI,
    });
    const d = evaluatePolicy({
      state: s,
      valueWei: 10n * MIN_PASSKEY_LIMIT_WEI,
      recentUsage: [
        { at: now - 1000, valueWei: 30n * MIN_PASSKEY_LIMIT_WEI },
        { at: now - 500, valueWei: 20n * MIN_PASSKEY_LIMIT_WEI },
      ],
      now,
    });
    expect(d.kind).toBe("over-limit");
    if (d.kind !== "over-limit") return;
    expect(d.mode).toBe("daily");
    expect(d.threshold).toBe(50n * MIN_PASSKEY_LIMIT_WEI);
    expect(d.attempted).toBe(60n * MIN_PASSKEY_LIMIT_WEI);
  });

  it("daily: prunes stale entries before checking the cap", () => {
    let s = appendCredential(emptyVaultPasskeyState(), fakeCred(1));
    s = setPolicy(s, {
      ...s.policy,
      enabled: true,
      mode: "daily",
      limitWei: 10n * MIN_PASSKEY_LIMIT_WEI,
      dailyCapWei: 50n * MIN_PASSKEY_LIMIT_WEI,
    });
    const d = evaluatePolicy({
      state: s,
      valueWei: 10n * MIN_PASSKEY_LIMIT_WEI,
      // Big spend 25h ago — outside the window, should not count
      recentUsage: [
        { at: now - DAILY_CAP_WINDOW_MS - 1, valueWei: 999n * MIN_PASSKEY_LIMIT_WEI },
      ],
      now,
    });
    expect(d.kind).toBe("passkey-ok");
  });
});

describe("buildPasskeyChallenge", () => {
  it("produces a 32-byte digest", () => {
    const c = buildPasskeyChallenge(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    );
    expect(c.length).toBe(32);
  });

  it("changes when txHash changes", () => {
    const nonce = new Uint8Array([0, 0, 0]);
    const a = buildPasskeyChallenge(new Uint8Array([1]), nonce);
    const b = buildPasskeyChallenge(new Uint8Array([2]), nonce);
    expect(a).not.toEqual(b);
  });

  it("changes when nonce changes", () => {
    const tx = new Uint8Array([1, 2, 3]);
    const a = buildPasskeyChallenge(tx, new Uint8Array([1]));
    const b = buildPasskeyChallenge(tx, new Uint8Array([2]));
    expect(a).not.toEqual(b);
  });

  it("accepts a null txHash (unlock-only / registration flavour)", () => {
    const nonce = new Uint8Array([7, 8, 9]);
    const a = buildPasskeyChallenge(null, nonce);
    expect(a.length).toBe(32);
    const b = buildPasskeyChallenge(new Uint8Array(0), nonce);
    // null + zero-length tx both go through the same code path:
    // domain || (empty) || nonce — so they coincide. Tightly defined.
    expect(a).toEqual(b);
  });
});
