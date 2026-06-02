// spending-policy-tx encoder golden vectors.
//
// Pins the §18.8 spending-policy wrappers to the SDK 0.3.10 encoders +
// the chain-canonical selectors WITHOUT a live chain — the only way to
// guarantee calldata correctness for a consensus-critical
// (rejected-at-admission) surface offline:
//   1. The precompile address resolves to 0x110C.
//   2. SPENDING_POLICY_SELECTORS pin (setPolicyClaim 0x35531f6c,
//      disable 0xe6c09edf, etc.) and the wallet wrappers carry them.
//   3. encodeSetPolicyClaim THROWS (SpendingPolicyError) on a pubkey
//      that is not 1952 bytes or a signature that is not 3309 bytes —
//      the wrong-size guard the chain enforces, asserted client-side.
//   4. The claim calldata posts to spendingPolicyAddressHex() and
//      embeds a well-formed pubkey/sig at the canonical lengths.
//   5. packTimeWindow round-trips through decodeTimeWindow.
//   6. enable/disable encode the bech32m sub-account address.

import { describe, expect, it } from "vitest";
import {
  SPENDING_POLICY_SELECTORS,
  ML_DSA_65_PUBLIC_KEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
  spendingPolicyAddressHex,
  encodeSetPolicyClaimCalldata,
  encodeDisableCalldata,
  encodeEnableCalldata,
  addressToTypedBech32,
} from "@monolythium/core-sdk";
import {
  SPENDING_POLICY_PRECOMPILE,
  buildSpendingPolicyArgs,
  composeClaimMessage,
  decodeTimeWindow,
  encodeDisable,
  encodeEnable,
  encodeSetPolicyClaim,
  lythToLythoshi,
  packTimeWindow,
  type SpendingPolicyForm,
} from "./spending-policy-tx.js";

// A typed `mono` bech32m sub-account / principal pair, derived from the
// SDK's own `user`→bech32m codec so the checksum is always valid (the
// §18.8 encoders reject a bad-checksum address). Distinct underlying
// 20-byte addresses so claim-message determinism vectors are meaningful.
const SUB_ACCOUNT = addressToTypedBech32(
  "user",
  "0x1111111111111111111111111111111111111111",
);
const PRINCIPAL = addressToTypedBech32(
  "user",
  "0x2222222222222222222222222222222222222222",
);

function baseForm(): SpendingPolicyForm {
  return {
    subAccount: SUB_ACCOUNT,
    principal: PRINCIPAL,
    perTxCapLyth: "10",
    dailyCapLyth: "100",
    weeklyCapLyth: "500",
    monthlyCapLyth: "2000",
    timeWindow: null,
    policyExpiryUnixSeconds: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Precompile address + selectors
// ─────────────────────────────────────────────────────────────────────────────

describe("SPENDING_POLICY_PRECOMPILE", () => {
  it("is the §18.8 address (0x110C) resolved from the SDK", () => {
    expect(SPENDING_POLICY_PRECOMPILE).toBe(spendingPolicyAddressHex());
    expect(SPENDING_POLICY_PRECOMPILE.toLowerCase()).toBe(
      "0x000000000000000000000000000000000000110c",
    );
  });
});

describe("SPENDING_POLICY_SELECTORS", () => {
  it("pins the chain-canonical 4-byte selectors", () => {
    expect(SPENDING_POLICY_SELECTORS.setPolicy).toBe("0x8da1a765");
    expect(SPENDING_POLICY_SELECTORS.setPolicyClaim).toBe("0x35531f6c");
    expect(SPENDING_POLICY_SELECTORS.claimPolicyByAddress).toBe("0x0c21376c");
    expect(SPENDING_POLICY_SELECTORS.enable).toBe("0x5bfa1b68");
    expect(SPENDING_POLICY_SELECTORS.disable).toBe("0xe6c09edf");
    expect(SPENDING_POLICY_SELECTORS.recordSpend).toBe("0xdca04292");
  });
});

describe("ML-DSA-65 length constants", () => {
  it("are the FIPS-204 pubkey (1952) + signature (3309) lengths", () => {
    expect(ML_DSA_65_PUBLIC_KEY_LEN).toBe(1952);
    expect(ML_DSA_65_SIGNATURE_LEN).toBe(3309);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// encodeSetPolicyClaim — fresh-claim path (0x35531f6c)
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeSetPolicyClaim", () => {
  const pubkey = new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN).fill(0xab);
  const sig = new Uint8Array(ML_DSA_65_SIGNATURE_LEN).fill(0xcd);

  it("equals the SDK encoder byte-for-byte + carries the setPolicyClaim selector", () => {
    const args = buildSpendingPolicyArgs(baseForm());
    const data = encodeSetPolicyClaim(args, pubkey, sig);
    expect(data).toBe(encodeSetPolicyClaimCalldata(args, pubkey, sig));
    expect(data.startsWith("0x35531f6c")).toBe(true);
    // Calldata is large: selector + ABI for all §18.8 dims + the
    // 1952-byte pubkey + 3309-byte sig.
    expect(data.length).toBeGreaterThan(2 + 8 + (1952 + 3309) * 2);
  });

  it("THROWS when the pubkey is not 1952 bytes (consensus guard)", () => {
    const args = buildSpendingPolicyArgs(baseForm());
    const shortPubkey = new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN - 1).fill(0xab);
    expect(() => encodeSetPolicyClaim(args, shortPubkey, sig)).toThrow();
    const longPubkey = new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN + 1).fill(0xab);
    expect(() => encodeSetPolicyClaim(args, longPubkey, sig)).toThrow();
  });

  it("THROWS when the signature is not 3309 bytes (consensus guard)", () => {
    const args = buildSpendingPolicyArgs(baseForm());
    const shortSig = new Uint8Array(ML_DSA_65_SIGNATURE_LEN - 1).fill(0xcd);
    expect(() => encodeSetPolicyClaim(args, pubkey, shortSig)).toThrow();
    const longSig = new Uint8Array(ML_DSA_65_SIGNATURE_LEN + 1).fill(0xcd);
    expect(() => encodeSetPolicyClaim(args, pubkey, longSig)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeClaimMessage — the bytes the sub-account signs
// ─────────────────────────────────────────────────────────────────────────────

describe("composeClaimMessage", () => {
  it("is deterministic + chain-id-bound (different chainId → different bytes)", () => {
    const args = buildSpendingPolicyArgs(baseForm());
    const a = composeClaimMessage(69420, args);
    const b = composeClaimMessage(69420, args);
    const other = composeClaimMessage(1, args);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBeGreaterThan(0);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(other));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enable / disable (= revoke)
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeEnable / encodeDisable", () => {
  it("equal the SDK encoders + carry the enable/disable selectors", () => {
    const enable = encodeEnable(SUB_ACCOUNT);
    expect(enable).toBe(encodeEnableCalldata(SUB_ACCOUNT));
    expect(enable.startsWith("0x5bfa1b68")).toBe(true);

    const disable = encodeDisable(SUB_ACCOUNT);
    expect(disable).toBe(encodeDisableCalldata(SUB_ACCOUNT));
    expect(disable.startsWith("0xe6c09edf")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// packTimeWindow / decodeTimeWindow
// ─────────────────────────────────────────────────────────────────────────────

describe("packTimeWindow / decodeTimeWindow", () => {
  it("round-trips a 9→17 window", () => {
    const word = packTimeWindow(true, 9, 17);
    expect(word.length).toBe(32);
    expect(decodeTimeWindow(word)).toEqual([9, 17]);
  });

  it("round-trips a midnight-wrap window (22→6)", () => {
    expect(decodeTimeWindow(packTimeWindow(true, 22, 6))).toEqual([22, 6]);
  });

  it("encodes the all-zero word as 'no window' (null)", () => {
    expect(decodeTimeWindow(packTimeWindow(false, 0, 0))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LYTH → lythoshi (18 decimals; chain migrated 8 → 18, 1 lythoshi == 1 wei)
// ─────────────────────────────────────────────────────────────────────────────

describe("lythToLythoshi", () => {
  it("converts whole + fractional LYTH at 18 decimals", () => {
    expect(lythToLythoshi("1")).toBe(1_000_000_000_000_000_000n);
    expect(lythToLythoshi("0.000000000000000001")).toBe(1n); // 1 lythoshi
    expect(lythToLythoshi("12.5")).toBe(12_500_000_000_000_000_000n);
  });

  it("treats empty / '0' as no cap (0n)", () => {
    expect(lythToLythoshi("")).toBe(0n);
    expect(lythToLythoshi("0")).toBe(0n);
  });

  it("rejects > 18 decimal places + malformed input", () => {
    expect(() => lythToLythoshi("0.0000000000000000001")).toThrow();
    expect(() => lythToLythoshi("1.2.3")).toThrow();
    expect(() => lythToLythoshi("abc")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSpendingPolicyArgs — form → §18.8 args
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSpendingPolicyArgs", () => {
  it("maps all §18.8 dimensions (caps → lythoshi, roots default to zero)", () => {
    const args = buildSpendingPolicyArgs(baseForm());
    expect(args.subAccount).toBe(SUB_ACCOUNT);
    expect(args.principal).toBe(PRINCIPAL);
    expect(args.perTxCapLythoshi).toBe(10_000_000_000_000_000_000n); // 10 LYTH
    expect(args.dailyCapLythoshi).toBe(100_000_000_000_000_000_000n); // 100 LYTH
    expect(args.weeklyCapLythoshi).toBe(500_000_000_000_000_000_000n); // 500 LYTH
    expect(args.monthlyCapLythoshi).toBe(2_000_000_000_000_000_000_000n); // 2000 LYTH
    expect(args.allowRoot).toBe("0x" + "00".repeat(32));
    expect(args.denyRoot).toBe("0x" + "00".repeat(32));
    expect(args.categoryAllowRoot).toBe("0x" + "00".repeat(32));
    expect(args.policyExpiry).toBe(0n);
    // No window → all-zero packed word.
    expect(decodeTimeWindow(args.timeWindow as Uint8Array)).toBeNull();
  });

  it("packs a configured time window + carries a configured expiry", () => {
    const form = baseForm();
    form.timeWindow = { startHour: 8, endHour: 20 };
    form.policyExpiryUnixSeconds = 1_900_000_000;
    const args = buildSpendingPolicyArgs(form);
    expect(decodeTimeWindow(args.timeWindow as Uint8Array)).toEqual([8, 20]);
    expect(args.policyExpiry).toBe(1_900_000_000n);
  });

  it("rejects a non-32-byte counterparty root", () => {
    const form = baseForm();
    form.allowRoot = "0xdeadbeef";
    expect(() => buildSpendingPolicyArgs(form)).toThrow();
  });

  it("accepts a well-formed 32-byte counterparty root (MVP single root)", () => {
    const form = baseForm();
    const root = "0x" + "11".repeat(32);
    form.allowRoot = root;
    const args = buildSpendingPolicyArgs(form);
    expect(args.allowRoot).toBe(root);
  });
});
