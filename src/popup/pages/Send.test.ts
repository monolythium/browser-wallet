// Coverage for the Send page's recipient parser. The parser is the codec
// boundary: input may be 0x hex or bech32m (mono1...), but the IPC contract
// stays 0x-only. These tests pin the conversion paths against BIP-350
// canonical forms (lowercase + all-uppercase) and the rejection paths
// for mixed-case, wrong-HRP, and malformed inputs.

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

  it("partial 0x (length < 42) returns no error and inputForm=partial", () => {
    const r = validateToAddress("0x2aa6");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBeNull();
    expect(r.inputForm).toBe("partial");
  });

  it("partial mono1 (length < 44) returns no error and inputForm=partial", () => {
    const r = validateToAddress("mono1abc");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBeNull();
    expect(r.inputForm).toBe("partial");
  });
});

describe("validateToAddress — complete 0x", () => {
  it("lowercase 0x address parses, derives bech, no error", () => {
    const r = validateToAddress(ADDR0X_LOWER);
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
    expect(r.bech).toBe(addressToBech32m(ADDR0X_LOWER));
    expect(r.inputForm).toBe("0x");
  });

  it("mixed-case 0x address normalizes to lowercase", () => {
    const r = validateToAddress("0x2AA6a8C4e2f64c4d8b1c3e9b3E1f4d2A8c5E7d3f");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
  });

  it("0X-prefix uppercase variant is accepted", () => {
    const r = validateToAddress("0X" + ADDR0X.slice(2));
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
  });

  it("wrong-length (43 chars) reports an error", () => {
    const r = validateToAddress(ADDR0X + "f");
    expect(r.error).toMatch(/42 chars/);
    expect(r.addr0x).toBeNull();
  });

  it("non-hex char in 42-char form reports an error", () => {
    const garbage = "0x" + "z".repeat(40);
    const r = validateToAddress(garbage);
    expect(r.error).toMatch(/40 hex chars/);
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
    expect(r.error).toMatch(/0x.*mono1.*\.mono/);
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
  it("accepts and round-trips the smallest 8-decimal LYTH amount", () => {
    expect(validateAmount("0.00000001")).toBeNull();
    expect(lythToLythoshiHex("0.00000001")).toBe("0x1");
    expect(lythoshiToLythString(1n)).toBe("0.00000001");
  });

  it("formats mixed whole/fractional lythoshi without trailing zeros", () => {
    expect(lythToLythoshiHex("1.23456789")).toBe("0x75bcd15");
    expect(lythoshiToLythString(123_456_789n)).toBe("1.23456789");
    expect(lythoshiToLythString(100_000_000n)).toBe("1");
  });

  it("rejects 9-decimal native LYTH input", () => {
    expect(validateAmount("0.000000001")).toBe(
      "amount cannot have more than 8 decimal places",
    );
  });
});

describe("native LYTH fee display math", () => {
  const fee = {
    maxPriorityFeePerGas: "0x5",
    maxFeePerGas: "0x8",
    baseFeePerGas: "0x3",
    gasLimit: "0xa",
  };

  it("computes estimated fees in lythoshi from price-per-execution-unit fields", () => {
    expect(computeEstimatedFeeLythoshi(fee, 5_000n)).toBe(50n);
    expect(computeEstimatedFeeLythoshi(fee, 10_000n)).toBe(80n);
    expect(computeEstimatedFeeLythoshi(fee, 20_000n)).toBe(130n);
  });

  it("uses the native-transfer fallback execution-unit limit when omitted", () => {
    expect(
      computeEstimatedFeeLythoshi(
        {
          maxPriorityFeePerGas: "0x1",
          maxFeePerGas: "0x3",
          baseFeePerGas: "0x2",
          gasLimit: null,
        },
        10_000n,
      ),
    ).toBe(63_000n);
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
    const text = formatNativeLythAmount(80n);
    expect(text).toBe("0.0000008 LYTH");
    expect(text).not.toMatch(/gwei|lythoshi|execution unit/i);
  });
});

// Phase 4.3.1 — method-aware error rendering. The smoke testing on
// Phase 4.3 revealed "Chain rejected:" was being prefixed to every
// admission-reject code in [-32049, -32020] regardless of which RPC
// method actually threw, conflating pre-submit lookup failures with
// real lyth_submitEncrypted rejects. These cases pin the per-method
// copy produced by formatSendError.
describe("formatSendError — method-aware copy", () => {
  const ADMISSION = -32030; // anywhere in [-32049, -32020]
  const NON_ADMISSION = -32600;

  it("lyth_submitEncrypted + admission code → 'Mempool rejected', not 'Chain rejected'", () => {
    const s = formatSendError({
      message: "mempool: decryption failed",
      code: ADMISSION,
      method: "lyth_submitEncrypted",
      via: "operator-2",
    });
    expect(s).toContain("Mempool rejected");
    expect(s).not.toContain("Chain rejected");
    expect(s).toContain("via operator-2");
  });

  it("lyth_submitEncrypted + non-admission code → 'Submission failed'", () => {
    const s = formatSendError({
      message: "internal error",
      code: NON_ADMISSION,
      method: "lyth_submitEncrypted",
      via: "operator-3",
    });
    expect(s).toContain("Submission failed");
    expect(s).not.toContain("Mempool rejected");
  });

  it("lyth_getEncryptionKey → 'Couldn't fetch encryption key'", () => {
    const s = formatSendError({
      message: "upstream unavailable: mempool: decryption failed",
      code: ADMISSION,
      method: "lyth_getEncryptionKey",
      via: "operator-2",
    });
    expect(s).toContain("Couldn't fetch encryption key");
    expect(s).toContain("lyth_getEncryptionKey");
    expect(s).toContain("via operator-2");
    expect(s).not.toContain("Chain rejected");
  });

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

  it("method missing + admission code → legacy verbatim 'Chain rejected: ${message}'", () => {
    const s = formatSendError({
      message: "decryption failed",
      code: ADMISSION,
      method: null,
      via: null,
    });
    // Exact match — back-compat with SWs that lag the popup version.
    expect(s).toBe("Chain rejected: decryption failed");
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
