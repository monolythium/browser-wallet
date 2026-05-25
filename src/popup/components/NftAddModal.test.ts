import { describe, expect, it } from "vitest";

import {
  NFT_CONTRACT_ADDRESS_PLACEHOLDER,
  parseNftContractAddressInput,
} from "./NftAddModal.js";

const CONTRACT = "0x2222222222222222222222222222222222222222";
const CONTRACT_TYPED = "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd";

describe("NftAddModal contract address parsing", () => {
  it("accepts typed monoc contract addresses and returns internal 0x bytes", () => {
    expect(parseNftContractAddressInput(CONTRACT_TYPED)).toEqual({
      ok: true,
      typed: CONTRACT_TYPED,
      hex: CONTRACT,
    });
  });

  it("rejects raw 0x contract addresses at the public input boundary", () => {
    expect(parseNftContractAddressInput(CONTRACT)).toEqual({
      ok: false,
      reason:
        "NFT contract address raw 0x addresses are retired; use a typed monoc1 address",
    });
  });

  it("uses a typed contract placeholder", () => {
    expect(NFT_CONTRACT_ADDRESS_PLACEHOLDER).toMatch(/^monoc1/);
    expect(NFT_CONTRACT_ADDRESS_PLACEHOLDER).not.toContain("0x");
  });
});
