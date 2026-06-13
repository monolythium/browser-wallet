// Send-error classifier tests.

import { describe, expect, it } from "vitest";
import { classifySendError, errorLinksOperators } from "./send-error.js";

describe("classifySendError — kind detection", () => {
  it.each([
    ["Chain genesis mismatch — all 14 operators reported untrusted genesis. See Operators.", "genesis-mismatch"],
    ["operator-3: untrusted genesis", "genesis-mismatch"],
    ["Chain rejected: plaintext mempool entry not allowed: encrypted envelope required", "plaintext-not-allowed"],
    ["plaintext not allowed", "plaintext-not-allowed"],
    ["encrypted mempool required", "plaintext-not-allowed"],
    // Ordering regression guard: the chain wraps the encrypted-required
    // rejection in "upstream unavailable: mempool: …", so the SPECIFIC
    // plaintext-not-allowed branch must win over the GENERIC chain-quarantined
    // "upstream unavailable" match (the two branches were reordered for this).
    [
      "upstream unavailable: mempool: plaintext mempool entry not allowed: encrypted envelope required",
      "plaintext-not-allowed",
    ],
    // …but a bare "upstream unavailable" outage WITHOUT the encrypted substring
    // must STILL fall through to chain-quarantined (the reorder must not broaden).
    ["upstream unavailable", "chain-quarantined"],
    ["protocore quarantine clear; state-root mismatch", "chain-quarantined"],
    // intrinsic-floor rejection (esp. encrypted sealed submissions) — must NOT
    // read as a chain-quarantine despite the "upstream unavailable" wrapper.
    [
      "upstream unavailable: mempool: tx execution-unit limit 30000 below intrinsic floor 248213",
      "gas-estimation",
    ],
    // replace-underpriced (a tx already pending at this nonce) — also wrapped in
    // "upstream unavailable"; must NOT read as a chain-quarantine.
    ["upstream unavailable: mempool: replace underpriced", "nonce-conflict"],
    // SYSTEMIC unwrap-inner-first (Part 2A): mono-core flattens EVERY admission
    // error into "upstream unavailable: mempool: <inner>" (-32047), so the two
    // most common send failures were stolen by chain-quarantined. After the
    // unwrap they classify on their inner reason, NOT as an operator outage.
    [
      "upstream unavailable: mempool: insufficient balance for max execution-unit cost",
      "insufficient-funds",
    ],
    ["upstream unavailable: mempool: nonce too low: expected 5, got 4", "nonce-conflict"],
    // spending-policy CREATE-forbidden shares the -32047 code with the wrapper,
    // but its inner text disambiguates it (Part 2A C3).
    [
      "upstream unavailable: mempool: spending-policy: CREATE not permitted from sub-accounts with destination policy configured",
      "spending-policy-blocked",
    ],
    // SpendingPolicyStorageRead (LOW): a TRANSIENT admission-time backend
    // storage-read fault — the user's policy is fine. Must NOT read as
    // spending-policy-blocked ("adjust your policy"); classifies as the
    // retryable transient (checked before the generic spending-policy branch).
    [
      "upstream unavailable: mempool: spending-policy: admission-time storage read failed: backend timeout",
      "spending-policy-unavailable",
    ],
    ["spending-policy: admission-time storage read failed: disk i/o", "spending-policy-unavailable"],
    // An admission inner with no specific branch is an honest transaction
    // rejection — NOT an operator outage.
    ["upstream unavailable: mempool: signature invalid", "transaction-rejected"],
    ["insufficient funds for transfer", "insufficient-funds"],
    ["INSUFFICIENT BALANCE", "insufficient-funds"],
    ["not enough balance to cover gas", "insufficient-funds"],
    ["gas required exceeds allowance (300000)", "gas-estimation"],
    ["intrinsic gas too low; sender 0xabc", "gas-estimation"],
    ["cannot estimate gas: execution may fail", "gas-estimation"],
    ["nonce too low; have 14, want 15", "nonce-conflict"],
    ["nonce already used", "nonce-conflict"],
    ["operator unreachable", "operator-offline"],
    ["request timeout after 5000ms", "operator-offline"],
    ["rpc error: -32603", "operator-offline"],
    ["User rejected the request", "user-rejected"],
    ["user denied transaction signature", "user-rejected"],
    ["execution reverted: insufficient allowance", "transaction-reverted"],
    ["spending policy denied", "spending-policy-blocked"],
    ["wallet locked", "wallet-locked"],
    ["wallet is locked", "wallet-locked"],
    // NN-01 fail-closed vault-binding abort (wallet-internal). The raw sentinel
    // and the SW-wrapped dApp form ("ml-dsa tx failed: <sentinel>") both classify
    // via the unique "active account changed" substring — NOT user-rejected
    // despite the word "cancelled" (it lacks "cancelled by user"/"user rejected").
    [
      "active account changed during signing — transaction cancelled for safety",
      "active-vault-changed",
    ],
    [
      "ml-dsa tx failed: active account changed during signing — transaction cancelled for safety",
      "active-vault-changed",
    ],
    ["random garbage message no one recognises", "unknown"],
  ])("classifies %j as %s", (msg, expected) => {
    expect(classifySendError(msg).kind).toBe(expected);
  });
});

describe("classifySendError — copy quality", () => {
  it("every kind has non-empty headline and body", () => {
    const inputs = [
      "plaintext mempool entry not allowed: encrypted envelope required",
      "insufficient funds",
      "intrinsic gas too low",
      "nonce too low",
      "operator unreachable",
      "some unrecognised error",
      "user rejected",
      "execution reverted",
      "spending policy denied",
      "wallet locked",
      "totally unknown error",
    ];
    for (const i of inputs) {
      const r = classifySendError(i);
      expect(r.headline.length).toBeGreaterThan(0);
      expect(r.body.length).toBeGreaterThan(0);
    }
  });

  it("unknown preserves the raw message in body for debugging", () => {
    const r = classifySendError("some weird chain message");
    expect(r.body).toContain("some weird chain message");
  });
});

describe("classifySendError — insufficient-funds context enrichment", () => {
  it("includes balance + need + shortfall when context supplied", () => {
    const r = classifySendError("insufficient funds", {
      // Chain migrated 8 → 18 decimals: 1 LYTH = 10^18 lythoshi.
      walletBalanceLythoshiHex: "0x" + 1_000_000_000_000_000_000n.toString(16), // 1 LYTH
      txValueLythoshiHex: "0x" + 3_000_000_000_000_000_000n.toString(16), // 3 LYTH
      estimatedNetworkFeeLythoshiHex: "0x" + 10_000_000_000_000_000n.toString(16), // 0.01 LYTH
    });
    expect(r.body).toContain("1 LYTH");
    expect(r.body).toContain("3.01 LYTH"); // total needed
    expect(r.body).toContain("2.01 LYTH"); // shortfall
    expect(r.body).toContain("network fee");
    expect(r.body).not.toContain("gas");
  });

  it("falls back to generic copy when context is partial", () => {
    const r = classifySendError("insufficient funds", {
      walletBalanceLythoshiHex: "0x100",
      // value omitted
    });
    // Generic copy uses "amount plus network fee" phrasing; specific breakdown
    // uses the "you have X LYTH but this transaction needs Y LYTH" form.
    expect(r.body).toContain("amount plus the network fee");
    expect(r.body).not.toContain("Shortfall");
  });

  it("falls back to generic copy when no context is supplied", () => {
    const r = classifySendError("insufficient funds");
    expect(r.body).toContain("amount plus the network fee");
  });

  it("handles invalid hex without throwing", () => {
    const r = classifySendError("insufficient funds", {
      walletBalanceLythoshiHex: "0xZZZ",
      txValueLythoshiHex: "0x100",
    });
    // parseHexOrNull returns null for invalid; falls back to generic.
    expect(r.body).toContain("amount plus the network fee");
  });

  it("uses lythoshi precision for the smallest native shortfall", () => {
    const r = classifySendError("insufficient funds", {
      walletBalanceLythoshiHex: "0x0",
      txValueLythoshiHex: "0x1",
    });
    // 1 lythoshi == 1 wei == 10^-18 LYTH after the 8 → 18 migration.
    expect(r.body).toContain("0.000000000000000001 LYTH");
  });
});

describe("classifySendError — native fee wording", () => {
  it("uses network fee and execution-unit wording for estimation failures", () => {
    const r = classifySendError("cannot estimate gas: execution may fail");
    expect(r.kind).toBe("gas-estimation");
    expect(r.headline).toBe("Could not estimate network fee");
    expect(r.body).toContain("execution units");
    expect(r.headline).not.toContain("gas");
    expect(r.body).not.toContain("gas");
  });
});

describe("classifySendError — severity", () => {
  it("user-rejected is info severity (not an error)", () => {
    const r = classifySendError("user rejected");
    expect(r.severity).toBe("info");
  });

  it("nonce-conflict is warn (recoverable)", () => {
    const r = classifySendError("nonce too low");
    expect(r.severity).toBe("warn");
  });

  it("insufficient-funds is err", () => {
    const r = classifySendError("insufficient funds");
    expect(r.severity).toBe("err");
  });

  it("active-vault-changed is warn (transient, retryable — renders amber), not stolen by user-rejected", () => {
    const r = classifySendError(
      "active account changed during signing — transaction cancelled for safety",
    );
    expect(r.kind).toBe("active-vault-changed");
    expect(r.severity).toBe("warn");
    // The body says "cancelled" but must NOT be mis-read as a user cancellation,
    // and it links no operators.
    expect(errorLinksOperators(r.kind)).toBe(false);
  });
});

describe("classifySendError — unwrap-inner-first (Part 2A systemic fix)", () => {
  // The two bugs the fix targets: the chain wraps these as
  // "upstream unavailable: mempool: <inner>" (-32047) and the old
  // chain-quarantined branch stole them — wrong kind, wrong severity, and a
  // misleading "the wallet uses other operators automatically / See Operators".
  it("wrapped insufficient-funds is err + Insufficient LYTH, NOT a warn operator outage", () => {
    const r = classifySendError(
      "upstream unavailable: mempool: insufficient balance for max execution-unit cost",
    );
    expect(r.kind).toBe("insufficient-funds");
    expect(r.severity).toBe("err");
    expect(r.headline).toBe("Insufficient LYTH");
    expect(r.headline).not.toContain("Operator");
    expect(errorLinksOperators(r.kind)).toBe(false);
  });

  it("wrapped nonce-too-low is a warn nonce-conflict, NOT an operator outage", () => {
    const r = classifySendError("upstream unavailable: mempool: nonce too low: expected 5, got 4");
    expect(r.kind).toBe("nonce-conflict");
    expect(r.severity).toBe("warn");
    expect(errorLinksOperators(r.kind)).toBe(false);
  });

  // The genuine operator outage must STILL route to chain-quarantined.
  it("bare 'upstream unavailable' (no mempool inner) stays chain-quarantined + links Operators", () => {
    const r = classifySendError("upstream unavailable");
    expect(r.kind).toBe("chain-quarantined");
    expect(errorLinksOperators(r.kind)).toBe(true);
  });

  // An admission inner with no specific branch: honest transaction rejection,
  // carrying the inner reason — never an operator outage, never "unknown".
  it("unrecognized wrapped inner is an honest transaction-rejected carrying the inner reason", () => {
    const r = classifySendError("upstream unavailable: mempool: signature invalid");
    expect(r.kind).toBe("transaction-rejected");
    expect(r.severity).toBe("err");
    expect(r.body).toContain("signature invalid");
    expect(r.headline).not.toContain("Operator");
    expect(errorLinksOperators(r.kind)).toBe(false);
  });

  // The prior three "hoist above chain-quarantined" patches must still classify
  // honestly — now via the inner, not the reorder (the regression guard).
  it.each([
    [
      "upstream unavailable: mempool: plaintext mempool entry not allowed: encrypted envelope required",
      "plaintext-not-allowed",
    ],
    [
      "upstream unavailable: mempool: tx execution-unit limit 30000 below intrinsic floor 248213",
      "gas-estimation",
    ],
    ["upstream unavailable: mempool: replace underpriced", "nonce-conflict"],
  ])("regression: %j still classifies as %s via the inner", (msg, expected) => {
    expect(classifySendError(msg).kind).toBe(expected);
  });

  // A non-wrapped direct error must be untouched by the unwrap (no-op).
  it("non-wrapped errors are unchanged by the unwrap step", () => {
    expect(classifySendError("insufficient funds for transfer").kind).toBe("insufficient-funds");
    expect(classifySendError("nonce too low; have 14, want 15").kind).toBe("nonce-conflict");
    expect(classifySendError("random garbage message no one recognises").kind).toBe("unknown");
  });
});

describe("classifySendError — tx-type-neutral copy (Part 2A C2)", () => {
  // The same classifier drives stake / undelegate / redelegate / claim / MRV
  // (all funnel through the submitMlDsaTx chokepoint), so messages must not be
  // phrased send-/contract-specific where a non-send tx hits them.
  it("transaction-reverted copy is neutral (no 'recipient contract' / 'function arguments')", () => {
    const r = classifySendError("execution reverted: insufficient allowance");
    expect(r.kind).toBe("transaction-reverted");
    expect(r.headline).not.toMatch(/recipient/i);
    expect(r.body).not.toMatch(/recipient/i);
    expect(r.body).not.toMatch(/function arguments/i);
  });

  it("gas-estimation copy drops the send-only 'recipient address and amount' but keeps execution-unit wording", () => {
    const r = classifySendError("cannot estimate gas: execution may fail");
    expect(r.kind).toBe("gas-estimation");
    expect(r.body).not.toMatch(/recipient/i);
    expect(r.body).toContain("execution units"); // native fee wording preserved
    expect(r.body).not.toContain("gas");
  });
});

describe("classifySendError — shared -32047 code disambiguated by inner (Part 2A C3)", () => {
  // mono-core reuses code -32047 for BOTH the UpstreamUnavailable wrapper AND
  // SpendingPolicyCreateForbidden (mempool/error.rs:395). Classification is by
  // the inner MESSAGE, not the code, so once C1 unwraps the wrapper the two
  // distinct inner Display strings route to distinct kinds — they must never
  // cross-classify. (Exact mono-core Display strings used below.)
  it("plaintext-not-allowed -32047 → 'Encrypted transactions required', never spending-policy", () => {
    const r = classifySendError(
      "upstream unavailable: mempool: plaintext mempool entry not allowed: encrypted envelope required",
    );
    expect(r.kind).toBe("plaintext-not-allowed");
    expect(r.headline).toBe("Encrypted transactions required");
  });

  it("SpendingPolicyCreateForbidden -32047 → spending-policy-blocked, never 'Encrypted transactions required'", () => {
    const r = classifySendError(
      "upstream unavailable: mempool: spending-policy: CREATE not permitted from sub-accounts with destination policy configured",
    );
    expect(r.kind).toBe("spending-policy-blocked");
    expect(r.headline).not.toBe("Encrypted transactions required");
  });

  it("the two -32047 inners do not cross-classify", () => {
    const plaintext = classifySendError(
      "upstream unavailable: mempool: plaintext mempool entry not allowed: encrypted envelope required",
    ).kind;
    const policy = classifySendError(
      "upstream unavailable: mempool: spending-policy: CREATE not permitted from sub-accounts with destination policy configured",
    ).kind;
    expect(plaintext).not.toBe(policy);
    expect(plaintext).toBe("plaintext-not-allowed");
    expect(policy).toBe("spending-policy-blocked");
  });

  it("SpendingPolicyStorageRead → spending-policy-unavailable (transient/retry), never spending-policy-blocked", () => {
    const r = classifySendError(
      "upstream unavailable: mempool: spending-policy: admission-time storage read failed: backend timeout",
    );
    // Transient I/O fault — the user's policy is fine. Must NOT advise "adjust
    // your policy" (that's spending-policy-blocked).
    expect(r.kind).toBe("spending-policy-unavailable");
    expect(r.kind).not.toBe("spending-policy-blocked");
    expect(r.body.toLowerCase()).toMatch(/try again|temporary|moment/);
    // And a GENUINE policy violation still classifies as blocked (no regression).
    expect(
      classifySendError(
        "upstream unavailable: mempool: spending-policy: CREATE not permitted from sub-accounts with destination policy configured",
      ).kind,
    ).toBe("spending-policy-blocked");
  });

  // INFO #6 closeout — the spending-policy-unavailable branch is hoisted ABOVE
  // genesis-mismatch + plaintext-not-allowed, so a storage-read <reason> that
  // INCIDENTALLY contains those branches' trigger words is no longer stolen.
  it("storage-read reason mentioning 'genesis' still → spending-policy-unavailable (not genesis-mismatch)", () => {
    const r = classifySendError(
      "upstream unavailable: mempool: spending-policy: admission-time storage read failed: genesis snapshot read error",
    );
    expect(r.kind).toBe("spending-policy-unavailable");
    expect(r.kind).not.toBe("genesis-mismatch");
  });

  it("storage-read reason mentioning 'plaintext … not allowed' still → spending-policy-unavailable (not plaintext-not-allowed)", () => {
    const r = classifySendError(
      "upstream unavailable: mempool: spending-policy: admission-time storage read failed: plaintext page not allowed in cold store",
    );
    expect(r.kind).toBe("spending-policy-unavailable");
    expect(r.kind).not.toBe("plaintext-not-allowed");
  });

  it("the hoist does NOT regress genuine genesis-mismatch or plaintext-not-allowed (no storage-read signature)", () => {
    expect(classifySendError("operator-3: untrusted genesis").kind).toBe(
      "genesis-mismatch",
    );
    expect(
      classifySendError("Chain genesis mismatch — all 14 operators reported untrusted genesis").kind,
    ).toBe("genesis-mismatch");
    expect(
      classifySendError(
        "upstream unavailable: mempool: plaintext mempool entry not allowed: encrypted envelope required",
      ).kind,
    ).toBe("plaintext-not-allowed");
  });
});
