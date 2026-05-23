import { describe, expect, it } from "vitest";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import { validateMrcAccountLookupResponse } from "./mrc-account.js";

const ACCOUNT = addressToTypedBech32(
  "smartAccount",
  "0x1111111111111111111111111111111111111111",
);
const OTHER_ACCOUNT = addressToTypedBech32(
  "smartAccount",
  "0x2222222222222222222222222222222222222222",
);
const CONTROLLER = addressToTypedBech32(
  "user",
  "0x3333333333333333333333333333333333333333",
);
const RECOVERY = addressToTypedBech32(
  "user",
  "0x4444444444444444444444444444444444444444",
);

describe("MRC account lookup validator", () => {
  it("parses smart, policy, and bounded spend rows", () => {
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: ACCOUNT.toUpperCase(),
        spendLimit: 2,
        smartAccount: {
          kind: "smart_account",
          account: ACCOUNT.toUpperCase(),
          controller: CONTROLLER,
          recovery: RECOVERY,
          policyHash: null,
          nonce: "7",
          updatedAtBlock: "42",
        },
        policyAccount: {
          kind: "policy_account",
          account: ACCOUNT,
          controller: CONTROLLER,
          recovery: null,
          policyHash: "0x" + "55".repeat(32),
          nonce: null,
          updatedAtBlock: 43n,
        },
        policySpends: [
          {
            account: ACCOUNT,
            assetId: "0x" + "44".repeat(32),
            window: "9",
            amount: "20",
            spent: "45",
            updatedAtBlock: 44,
          },
          {
            account: ACCOUNT,
            assetId: "0x" + "45".repeat(32),
            window: "10",
            amount: "2",
            spent: "5",
            updatedAtBlock: 45,
          },
          {
            account: ACCOUNT,
            assetId: "0x" + "46".repeat(32),
            window: "11",
            amount: "3",
            spent: "6",
            updatedAtBlock: 46,
          },
        ],
      }),
    ).toEqual({
      schemaVersion: 1,
      account: ACCOUNT,
      spendLimit: 2,
      smartAccount: {
        kind: "smart_account",
        account: ACCOUNT,
        controller: CONTROLLER,
        recovery: RECOVERY,
        policyHash: null,
        nonce: "7",
        updatedAtBlock: 42,
      },
      policyAccount: {
        kind: "policy_account",
        account: ACCOUNT,
        controller: CONTROLLER,
        recovery: null,
        policyHash: "0x" + "55".repeat(32),
        nonce: null,
        updatedAtBlock: 43,
      },
      policySpends: [
        {
          account: ACCOUNT,
          assetId: "0x" + "44".repeat(32),
          window: "9",
          amount: "20",
          spent: "45",
          updatedAtBlock: 44,
        },
        {
          account: ACCOUNT,
          assetId: "0x" + "45".repeat(32),
          window: "10",
          amount: "2",
          spent: "5",
          updatedAtBlock: 45,
        },
      ],
    });
  });

  it("accepts empty lookup results without inventing records", () => {
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: ACCOUNT,
        spendLimit: 4,
        smartAccount: null,
        policyAccount: null,
        policySpends: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      account: ACCOUNT,
      spendLimit: 4,
      smartAccount: null,
      policyAccount: null,
      policySpends: [],
    });
  });

  it("rejects malformed required envelope and account fields", () => {
    expect(validateMrcAccountLookupResponse(null)).toBeNull();
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 2,
        account: ACCOUNT,
        spendLimit: 4,
        smartAccount: null,
        policyAccount: null,
        policySpends: [],
      }),
    ).toBeNull();
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: "mono1user",
        spendLimit: 4,
        smartAccount: null,
        policyAccount: null,
        policySpends: [],
      }),
    ).toBeNull();
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: ACCOUNT,
        spendLimit: 0,
        smartAccount: null,
        policyAccount: null,
        policySpends: [],
      }),
    ).toBeNull();
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: ACCOUNT,
        spendLimit: 4,
        smartAccount: {
          kind: "policy_account",
          account: ACCOUNT,
          controller: CONTROLLER,
          recovery: null,
          policyHash: null,
          nonce: null,
          updatedAtBlock: 1,
        },
        policyAccount: null,
        policySpends: [],
      }),
    ).toBeNull();
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: ACCOUNT,
        spendLimit: 4,
        smartAccount: {
          kind: "smart_account",
          account: OTHER_ACCOUNT,
          controller: CONTROLLER,
          recovery: null,
          policyHash: null,
          nonce: null,
          updatedAtBlock: 1,
        },
        policyAccount: null,
        policySpends: [],
      }),
    ).toBeNull();
  });

  it("enforces kind-specific nullable account fields", () => {
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: ACCOUNT,
        spendLimit: 4,
        smartAccount: {
          kind: "smart_account",
          account: ACCOUNT,
          controller: CONTROLLER,
          recovery: null,
          policyHash: "0x" + "55".repeat(32),
          nonce: "1",
          updatedAtBlock: 1,
        },
        policyAccount: null,
        policySpends: [],
      }),
    ).toBeNull();
    expect(
      validateMrcAccountLookupResponse({
        schemaVersion: 1,
        account: ACCOUNT,
        spendLimit: 4,
        smartAccount: null,
        policyAccount: {
          kind: "policy_account",
          account: ACCOUNT,
          controller: CONTROLLER,
          recovery: RECOVERY,
          policyHash: "0x" + "55".repeat(32),
          nonce: null,
          updatedAtBlock: 1,
        },
        policySpends: [],
      }),
    ).toBeNull();
  });

  it("filters malformed spend rows while keeping the response usable", () => {
    const out = validateMrcAccountLookupResponse({
      schemaVersion: 1,
      account: ACCOUNT,
      spendLimit: 4,
      smartAccount: null,
      policyAccount: null,
      policySpends: [
        { account: ACCOUNT, assetId: "0xasset", window: "1", amount: "2" },
        {
          account: OTHER_ACCOUNT,
          assetId: "0xasset",
          window: "2",
          amount: "3",
          spent: "4",
          updatedAtBlock: 5,
        },
        {
          account: ACCOUNT,
          assetId: "0xasset",
          window: "3",
          amount: "3",
          spent: "4",
          updatedAtBlock: 5,
        },
      ],
    });
    expect(out?.policySpends).toEqual([
      {
        account: ACCOUNT,
        assetId: "0xasset",
        window: "3",
        amount: "3",
        spent: "4",
        updatedAtBlock: 5,
      },
    ]);
  });
});
