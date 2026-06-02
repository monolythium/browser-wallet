// Send-error classifier tests.

import { describe, expect, it } from "vitest";
import { classifySendError } from "./send-error.js";

describe("classifySendError — kind detection", () => {
  it.each([
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
    ["encryption ceremony failed", "encryption-failure"],
    ["ferveo decryption mismatch", "encryption-failure"],
    ["ml-kem encapsulation failed", "encryption-failure"],
    ["User rejected the request", "user-rejected"],
    ["user denied transaction signature", "user-rejected"],
    ["execution reverted: insufficient allowance", "transaction-reverted"],
    ["spending policy denied", "spending-policy-blocked"],
    ["wallet locked", "wallet-locked"],
    ["wallet is locked", "wallet-locked"],
    ["random garbage message no one recognises", "unknown"],
  ])("classifies %j as %s", (msg, expected) => {
    expect(classifySendError(msg).kind).toBe(expected);
  });
});

describe("classifySendError — copy quality", () => {
  it("every kind has non-empty headline and body", () => {
    const inputs = [
      "insufficient funds",
      "intrinsic gas too low",
      "nonce too low",
      "operator unreachable",
      "ferveo error",
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
});
