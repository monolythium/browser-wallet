// Coverage for the Send page's recipient parser. The parser is the public
// typed-address boundary: input must be mono1... or a .mono name, while the
// IPC contract stays 0x-only internally. These tests pin the conversion paths
// against BIP-350 canonical forms (lowercase + all-uppercase) and the
// rejection paths for raw 0x, mixed-case, wrong-HRP, and malformed inputs.

import { describe, expect, it } from "vitest";
import {
  computeEstimatedFeeLythoshi,
  formatNativeLythAmount,
  formatSendError,
  lythToLythoshiHex,
  lythoshiToLythString,
  validateAmount,
  validateToAddress,
} from "./Send.js";
import { addressToBech32m } from "../../shared/bech32m.js";

const ADDR0X = "0x2aa6a8c4e2f64c4d8b1c3e9b3e1f4d2a8c5e7d3f";
const ADDR0X_LOWER = ADDR0X.toLowerCase();

describe("validateToAddress — empty / partial", () => {
  it("empty input returns no error and inputForm=empty", () => {
    const r = validateToAddress("");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBeNull();
    expect(r.bech).toBeNull();
    expect(r.inputForm).toBe("empty");
  });

  it("partial 0x is rejected at the public surface", () => {
    const r = validateToAddress("0x2aa6");
    expect(r.error).toMatch(/raw 0x addresses are retired/);
    expect(r.addr0x).toBeNull();
    expect(r.inputForm).toBe("0x");
  });

  it("partial mono1 (length < 44) returns no error and inputForm=partial", () => {
    const r = validateToAddress("mono1abc");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBeNull();
    expect(r.inputForm).toBe("partial");
  });
});

describe("validateToAddress — raw 0x", () => {
  it("lowercase 0x address is rejected", () => {
    const r = validateToAddress(ADDR0X_LOWER);
    expect(r.error).toMatch(/raw 0x addresses are retired/);
    expect(r.addr0x).toBeNull();
    expect(r.bech).toBeNull();
    expect(r.inputForm).toBe("0x");
  });

  it("mixed-case 0x address is rejected", () => {
    const r = validateToAddress("0x2AA6a8C4e2f64c4d8b1c3e9b3E1f4d2A8c5E7d3f");
    expect(r.error).toMatch(/raw 0x addresses are retired/);
    expect(r.addr0x).toBeNull();
  });

  it("0X-prefix uppercase variant is rejected", () => {
    const r = validateToAddress("0X" + ADDR0X.slice(2));
    expect(r.error).toMatch(/raw 0x addresses are retired/);
    expect(r.addr0x).toBeNull();
  });

  it("wrong-length raw 0x still reports the retired raw-address boundary", () => {
    const r = validateToAddress(ADDR0X + "f");
    expect(r.error).toMatch(/raw 0x addresses are retired/);
    expect(r.addr0x).toBeNull();
  });

  it("non-hex raw 0x still reports the retired raw-address boundary", () => {
    const garbage = "0x" + "z".repeat(40);
    const r = validateToAddress(garbage);
    expect(r.error).toMatch(/raw 0x addresses are retired/);
    expect(r.addr0x).toBeNull();
  });
});

describe("validateToAddress — complete mono1", () => {
  const BECH = addressToBech32m(ADDR0X_LOWER);

  it("lowercase mono1 decodes to the matching 0x form", () => {
    const r = validateToAddress(BECH);
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
    expect(r.bech).toBe(BECH);
    expect(r.inputForm).toBe("mono1");
  });

  it("all-uppercase MONO1 decodes (BIP-350 canonical)", () => {
    const upper = BECH.toUpperCase();
    const r = validateToAddress(upper);
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
    // bech is normalized to lowercase for display.
    expect(r.bech).toBe(BECH);
    expect(r.inputForm).toBe("mono1");
  });

  it("mixed-case mono1 is rejected per BIP-350", () => {
    // Find a letter position in the body and uppercase exactly that char,
    // leaving the rest lowercase. Using a random digit position would be
    // a no-op (digits are case-invariant) and the test would falsely pass.
    let mixed: string | null = null;
    for (let i = 5; i < BECH.length; i++) {
      const ch = BECH.charAt(i);
      if (ch >= "a" && ch <= "z") {
        mixed = BECH.slice(0, i) + ch.toUpperCase() + BECH.slice(i + 1);
        break;
      }
    }
    expect(mixed).not.toBeNull();
    const r = validateToAddress(mixed!);
    expect(r.error).not.toBeNull();
    expect(r.addr0x).toBeNull();
  });

  it("wrong-HRP bech32m (sprt1...) is rejected", () => {
    // Manually construct a valid-checksum bech32m for HRP "sprt" — we
    // don't have a helper, but the codec rejects unknown HRP at the
    // bech32mToAddress layer. Easier: take the mono1 form, swap "mono"
    // for "sprt" — the checksum will be wrong, which is also a valid
    // rejection path. Either way, error should fire.
    const wrong = "sprt1" + BECH.slice(5);
    const r = validateToAddress(wrong);
    expect(r.error).not.toBeNull();
    expect(r.addr0x).toBeNull();
  });
});

describe("validateToAddress — unknown / garbage", () => {
  it("non-0x non-mono1 non-.mono input reports a clear error", () => {
    const r = validateToAddress("hello world");
    expect(r.error).toMatch(/mono1.*\.mono/);
    expect(r.inputForm).toBe("unknown");
  });

  it("malformed mono name (mixed case, no resolver yet) is reported", () => {
    // Mixed-case is a §22.7/§22.8 canonicalization violation. The parser
    // surfaces a specific error rather than falling through to "unknown".
    const r = validateToAddress("Alice.mono");
    expect(r.error).toMatch(/not a valid mono name/);
    expect(r.inputForm).toBe("mono-name");
  });

  it("well-formed mono name is accepted (forward-resolve happens async)", () => {
    // The synchronous parser sets inputForm to "mono-name" and surfaces
    // the parsed canonical form; addr0x is left null because forward-
    // resolve is async (useNameForwardResolve reads chrome.storage).
    const r = validateToAddress("alice.mono");
    expect(r.error).toBeNull();
    expect(r.inputForm).toBe("mono-name");
    expect(r.addr0x).toBeNull();
    expect(r.monoName).not.toBeNull();
    expect(r.monoName?.tld).toBe("human");
    expect(r.monoName?.canonical).toBe("alice.mono");
  });
});

describe("native LYTH amount conversion — lythoshi precision", () => {
  it("accepts and round-trips the smallest 18-decimal LYTH amount", () => {
    // Chain migrated 8 → 18 decimals: 1 lythoshi == 1 wei == 10^-18 LYTH.
    expect(validateAmount("0.000000000000000001")).toBeNull();
    expect(lythToLythoshiHex("0.000000000000000001")).toBe("0x1");
    expect(lythoshiToLythString(1n)).toBe("0.000000000000000001");
  });

  it("formats mixed whole/fractional lythoshi without trailing zeros", () => {
    // 1.23456789 LYTH = 1.23456789 * 10^18 lythoshi.
    expect(lythToLythoshiHex("1.23456789")).toBe("0x112210f4768db400");
    expect(lythoshiToLythString(1_234_567_890_000_000_000n)).toBe("1.23456789");
    expect(lythoshiToLythString(1_000_000_000_000_000_000n)).toBe("1");
  });

  it("rejects 19-decimal native LYTH input", () => {
    expect(validateAmount("0.0000000000000000001")).toBe(
      "amount cannot have more than 18 decimal places",
    );
  });
});

describe("native LYTH fee display math", () => {
  // Realistic shape: suggestFee returns the 1-gwei mempool floor (1e9) as the
  // priority tip; base = 2 gwei; units = the 30000 native-transfer limit. The
  // headline total (computeEstimatedFeeLythoshi) and the Max reservation derived
  // from it must clamp the tier-scaled tip to the floor exactly as the submit
  // path signs it (fee-fix 6345e5c), or "Slow" under-reports vs the broadcast.
  const FLOOR_LYTHOSHI = 1_000_000_000n; // 1 gwei mempool priority-tip floor
  const base = 2_000_000_000n;
  const units = 30_000n;
  const fee = {
    priorityPricePerExecutionUnitLythoshiHex: "0x3b9aca00", // 1e9 = floor (suggestFee tip)
    maxPricePerExecutionUnitLythoshiHex: "0xb2d05e00", // 3e9 (inert for the total)
    basePricePerExecutionUnitLythoshiHex: "0x77359400", // 2e9
    executionUnitLimitHex: "0x7530", // 30000
  };

  it("clamps the Slow-tier headline up to the mempool floor so it matches the broadcast", () => {
    // Slow 0.5x scales the floor tip to 5e8 < floor → clamped back up to the
    // floor, so the headline (and the Max reservation = maxBasis − this) equals
    // the broadcast total (base + floor) × units, not the pre-fix under-report.
    const broadcastTotal = (base + FLOOR_LYTHOSHI) * units; // 9e13
    expect(computeEstimatedFeeLythoshi(fee, 5_000n)).toBe(broadcastTotal);
    const underReportedPreFix = (base + FLOOR_LYTHOSHI / 2n) * units; // 7.5e13
    expect(underReportedPreFix).toBeLessThan(broadcastTotal);
  });

  it("leaves normal (1x) and fast (2x) headline totals unchanged", () => {
    const estimate = (multBps: bigint): bigint => {
      const r = computeEstimatedFeeLythoshi(fee, multBps);
      if (r === null) throw new Error("unexpected null estimate");
      return r;
    };
    expect(estimate(10_000n)).toBe((base + FLOOR_LYTHOSHI) * units);
    // Slow now equals normal (both at the floor); fast stays strictly above.
    expect(estimate(5_000n)).toBe(estimate(10_000n));
    expect(estimate(20_000n)).toBe((base + 2n * FLOOR_LYTHOSHI) * units);
    expect(estimate(20_000n)).toBeGreaterThan(estimate(10_000n));
  });

  it("uses the native-transfer fallback execution-unit limit when omitted", () => {
    // executionUnitLimitHex null → 21000 fallback; priority at the floor so the
    // clamp is a no-op and only the fallback-units path is under test.
    expect(
      computeEstimatedFeeLythoshi(
        {
          priorityPricePerExecutionUnitLythoshiHex: "0x3b9aca00", // 1e9 = floor
          maxPricePerExecutionUnitLythoshiHex: "0xb2d05e00", // 3e9
          basePricePerExecutionUnitLythoshiHex: "0x77359400", // 2e9
          executionUnitLimitHex: null,
        },
        10_000n,
      ),
    ).toBe(63_000_000_000_000n); // (2e9 + 1e9) × 21000
  });

  it("does not fall back to compatibility fee fields when structured fee is malformed", () => {
    expect(
      computeEstimatedFeeLythoshi(
        {
          ...fee,
          structuredFee: {
            total_lythoshi: "80",
            total_lyth: "0.0000008",
            cycles_used: 10,
            base_price_per_cycle_lythoshi: "3",
            state_io_units: 0,
            state_io_price_per_unit_lythoshi: "0",
            priority_tip_lythoshi: "50",
            gasPrice: "0x5",
          },
        },
        10_000n,
      ),
    ).toBeNull();
  });

  it("renders the default fee quote as one LYTH amount without gwei wording", () => {
    // 80 lythoshi under the 18-decimal domain = 8 * 10^-17 LYTH.
    const text = formatNativeLythAmount(80n);
    expect(text).toBe("0.00000000000000008 LYTH");
    expect(text).not.toMatch(/gwei|lythoshi|execution unit/i);
  });
});

// Method-aware error rendering keeps pre-submit lookup failures distinct
// from chain-side submission rejects.
describe("formatSendError — method-aware copy", () => {
  const ADMISSION = -32030; // anywhere in [-32049, -32020]

  it("eth_feeHistory → 'Fee history fetch failed'", () => {
    const s = formatSendError({
      message: "feeHistory unavailable",
      code: ADMISSION,
      method: "eth_feeHistory",
      via: "operator-4",
    });
    expect(s).toContain("Fee history fetch failed");
    expect(s).toContain("eth_feeHistory");
    expect(s).toContain("via operator-4");
  });

  it("lyth_executionUnitPrice → 'Execution fee quote failed'", () => {
    const s = formatSendError({
      message: "fee unavailable",
      code: ADMISSION,
      method: "lyth_executionUnitPrice",
      via: "operator-4",
    });
    expect(s).toContain("Execution fee quote failed");
    expect(s).toContain("lyth_executionUnitPrice");
    expect(s).toContain("via operator-4");
  });

  it("lyth_getTransactionCount → 'Couldn't fetch account nonce'", () => {
    const s = formatSendError({
      message: "internal",
      code: ADMISSION,
      method: "lyth_getTransactionCount",
      via: "operator-5",
    });
    expect(s).toContain("Couldn't fetch account nonce");
    expect(s).toContain("lyth_getTransactionCount");
    expect(s).toContain("via operator-5");
  });

  it("eth_getTransactionCount → 'Couldn't fetch account nonce'", () => {
    const s = formatSendError({
      message: "internal",
      code: ADMISSION,
      method: "eth_getTransactionCount",
      via: "operator-5",
    });
    expect(s).toContain("Couldn't fetch account nonce");
    expect(s).toContain("eth_getTransactionCount");
    expect(s).toContain("via operator-5");
  });

  it("unknown method + admission code → 'Chain rejected' fallback with method + via suffix", () => {
    const s = formatSendError({
      message: "some chain error",
      code: ADMISSION,
      method: "lyth_estimateGas",
      via: "operator-2",
    });
    expect(s).toContain("Chain rejected");
    expect(s).toContain("lyth_estimateGas");
    expect(s).toContain("via operator-2");
  });

  it("method missing + admission code → generic 'Chain rejected: ${message}'", () => {
    const s = formatSendError({
      message: "decryption failed",
      code: ADMISSION,
      method: null,
      via: null,
    });
    expect(s).toBe("Chain rejected: decryption failed");
  });

  it("widened band: -32050/-32051 spending-policy rejects get the 'Chain rejected:' prefix", () => {
    // Upstream audit 2026-06-04: the mempool band grew to -32051
    // (SpendingPolicyMonthlyCapExceeded -32050, SpendingPolicyCategoryNotAllowed
    // -32051). Both are more negative than the old LO=-32049 and must now be
    // inside the admission band.
    for (const code of [-32050, -32051]) {
      const s = formatSendError({
        message: "spending-policy: monthly cap exceeded",
        code,
        method: null,
        via: null,
      });
      expect(s).toBe("Chain rejected: spending-policy: monthly cap exceeded");
    }
  });

  it("just below the band (-32052) is NOT treated as an admission reject", () => {
    const s = formatSendError({
      message: "some non-admission error",
      code: -32052,
      method: null,
      via: null,
    });
    expect(s).toBe("some non-admission error");
  });

  it("via === null → output does not contain ' via ' (graceful degradation)", () => {
    const s = formatSendError({
      message: "x",
      code: ADMISSION,
      method: "lyth_getEncryptionKey",
      via: null,
    });
    expect(s).not.toContain(" via ");
    expect(s).toContain("lyth_getEncryptionKey");
  });
});
