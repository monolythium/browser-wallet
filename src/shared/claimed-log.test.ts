import { describe, it, expect } from "vitest";
import {
  decodeClaimedAmountLythoshi,
  CLAIMED_EVENT_TOPIC0,
  MAX_PLAUSIBLE_CLAIM_LYTHOSHI,
} from "./claimed-log.js";
import { LYTHOSHI_PER_LYTH } from "@monolythium/core-sdk";

const PRECOMPILE = "0x000000000000000000000000000000000000100a";
const WALLET_TOPIC =
  "0x00000000000000000000000001029862840d227ee9e76a845c8cbb80ba1d7d23";

/** 32 big-endian bytes for a uint256 word. */
function word(amount: bigint): number[] {
  const b: number[] = new Array(32).fill(0);
  let v = amount;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/** A Claimed log with `data` as the operator byte-array shape: [amount, autoCompound]. */
function claimedLogBytes(amount: bigint, autoCompound = 0): Record<string, unknown> {
  return {
    address: PRECOMPILE,
    topics: [CLAIMED_EVENT_TOPIC0, WALLET_TOPIC],
    data: [...word(amount), ...word(BigInt(autoCompound))],
  };
}

function toHex(bytes: number[]): string {
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("decodeClaimedAmountLythoshi", () => {
  it("decodes word-0 from the operator byte-array data shape", () => {
    // Real probe value: block 98457 → 0.882914150695720660 LYTH.
    const amount = 882914150695720660n;
    expect(decodeClaimedAmountLythoshi([claimedLogBytes(amount)])).toBe(
      amount.toString(10),
    );
  });

  it("decodes word-0 from the eth-standard 0x-hex data shape", () => {
    const amount = 689999999999999998n; // block 98496
    const log = {
      address: PRECOMPILE,
      topics: [CLAIMED_EVENT_TOPIC0, WALLET_TOPIC],
      data: toHex([...word(amount), ...word(0n)]),
    };
    expect(decodeClaimedAmountLythoshi([log])).toBe(amount.toString(10));
  });

  it("is case-insensitive on address + topic0", () => {
    const amount = 1500000000000000000n;
    const log = {
      address: PRECOMPILE.toUpperCase().replace("0X", "0x"),
      topics: [CLAIMED_EVENT_TOPIC0.toUpperCase().replace("0X", "0x"), WALLET_TOPIC],
      data: [...word(amount), ...word(0n)],
    };
    expect(decodeClaimedAmountLythoshi([log])).toBe("1500000000000000000");
  });

  it("returns null when no log is from the delegation precompile", () => {
    const log = claimedLogBytes(5n);
    log.address = "0x" + "9".repeat(40);
    expect(decodeClaimedAmountLythoshi([log])).toBeNull();
  });

  it("returns null when the topic0 is not Claimed", () => {
    const log = claimedLogBytes(5n);
    log.topics = ["0x" + "a".repeat(64), WALLET_TOPIC];
    expect(decodeClaimedAmountLythoshi([log])).toBeNull();
  });

  it("returns null for absent / empty / non-array logs (no-mock — never 0)", () => {
    expect(decodeClaimedAmountLythoshi(undefined)).toBeNull();
    expect(decodeClaimedAmountLythoshi(null)).toBeNull();
    expect(decodeClaimedAmountLythoshi([])).toBeNull();
    expect(decodeClaimedAmountLythoshi("not-an-array")).toBeNull();
  });

  it("returns null when data is too short to hold word-0", () => {
    const log = { address: PRECOMPILE, topics: [CLAIMED_EVENT_TOPIC0], data: [1, 2, 3] };
    expect(decodeClaimedAmountLythoshi([log])).toBeNull();
  });

  it("picks the Claimed log out of a mixed logs array", () => {
    const noise = { address: "0x" + "1".repeat(40), topics: ["0x" + "2".repeat(64)], data: [] };
    const amount = 42n;
    expect(decodeClaimedAmountLythoshi([noise, claimedLogBytes(amount)])).toBe("42");
  });

  it("decodes the amount regardless of the autoCompound flag (word-1)", () => {
    const amount = 1234567890123456789n;
    expect(decodeClaimedAmountLythoshi([claimedLogBytes(amount, 1)])).toBe(
      amount.toString(10),
    );
  });

  it("returns null when the data omits the autoCompound word (SDK requires both words)", () => {
    // 32 bytes — amount word only, no autoCompound word. The SDK decoder
    // throws "data shorter than amount + autoCompound words" → caught → null.
    const log = {
      address: PRECOMPILE,
      topics: [CLAIMED_EVENT_TOPIC0, WALLET_TOPIC],
      data: [...word(5n)],
    };
    expect(decodeClaimedAmountLythoshi([log])).toBeNull();
  });

  it("returns null when the indexed wallet topic is absent (SDK requires 2 topics)", () => {
    // topic0 only, no indexed wallet topic. The SDK decoder throws on
    // topics.length !== 2 → caught → null (a real Claimed log carries both).
    const log = {
      address: PRECOMPILE,
      topics: [CLAIMED_EVENT_TOPIC0],
      data: [...word(7n), ...word(0n)],
    };
    expect(decodeClaimedAmountLythoshi([log])).toBeNull();
  });

  describe("MAX_PLAUSIBLE_CLAIM_LYTHOSHI bound (P5-004)", () => {
    it("pins the cap at 200M LYTH (2x genesis supply)", () => {
      expect(MAX_PLAUSIBLE_CLAIM_LYTHOSHI).toBe(200_000_000n * LYTHOSHI_PER_LYTH);
    });

    it("decodes an at-the-cap amount normally", () => {
      const atCap = MAX_PLAUSIBLE_CLAIM_LYTHOSHI;
      expect(decodeClaimedAmountLythoshi([claimedLogBytes(atCap)])).toBe(
        atCap.toString(10),
      );
    });

    it("returns null (undecodable → bare render) for an over-bound amount, never a huge number", () => {
      const overBound = MAX_PLAUSIBLE_CLAIM_LYTHOSHI + 1n;
      expect(decodeClaimedAmountLythoshi([claimedLogBytes(overBound)])).toBeNull();
    });

    it("rejects an absurd near-uint256-max echo as undecodable", () => {
      const absurd = (1n << 255n); // ~5.8e76 lythoshi
      expect(decodeClaimedAmountLythoshi([claimedLogBytes(absurd)])).toBeNull();
    });
  });
});
