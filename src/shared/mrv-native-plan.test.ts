import { describe, expect, it } from "vitest";
import {
  WALLET_MRV_TX_EXTENSION_KIND,
  buildWalletMrvCallNativePlan,
  buildWalletMrvDeployNativePlan,
  walletMrvNativePlanToSubmitTx,
} from "./mrv-native-plan.js";

const USER = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x2222222222222222222222222222222222222222";
const USER_BECH32 = "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at";
const CONTRACT_BECH32 = "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd";

describe("wallet MRV native tx plans", () => {
  it("builds a JSON-safe validated deploy plan from wallet hex inputs", () => {
    const artifactBytes = "0x13000000";
    const plan = buildWalletMrvDeployNativePlan({
      fromAddress: USER,
      chainIdHex: "0x10F2C",
      nonceHex: "0x7",
      executionUnitLimitHex: "0x100000",
      maxExecutionFeeLythoshiHex: "0x989680",
      priorityTipLythoshiHex: "0x5",
      valueWeiHex: "0x0",
      artifactBytes,
      artifactHash: "0x0707070707070707070707070707070707070707070707070707070707070707",
    });

    expect(plan.kind).toBe("mrv_deploy");
    expect(plan.request).toMatchObject({
      from: USER_BECH32,
      artifactBytes,
      valueLythoshi: "0",
      nonce: "7",
      executionUnitLimit: "1048576",
      maxExecutionFeeLythoshi: "10000000",
      priorityTipLythoshi: "5",
    });
    expect(plan.extension).toEqual({
      kind: WALLET_MRV_TX_EXTENSION_KIND,
      bodyHex: "0x01",
    });
    expect(plan.tx).toEqual({
      chainIdHex: "0x10f2c",
      nonceHex: "0x7",
      gasLimitHex: "0x100000",
      maxFeePerGas: "0x989680",
      maxPriorityFeePerGas: "0x5",
      to: null,
      valueWeiHex: "0x0",
      data: artifactBytes,
      extensions: [{ kind: WALLET_MRV_TX_EXTENSION_KIND, bodyHex: "0x01" }],
    });
    expect(plan.expectedContractAddress).toMatch(/^monoc1/);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("builds a JSON-safe validated contract call plan from mixed address inputs", () => {
    const plan = buildWalletMrvCallNativePlan({
      fromAddress: USER_BECH32,
      contractAddress: CONTRACT,
      chainIdHex: "0x10f2c",
      nonceHex: "0x8",
      executionUnitLimitHex: "0x200000",
      maxExecutionFeeLythoshiHex: "0x1312d00",
      input: "0xaabbccdd",
      valueWeiHex: "0x2a",
    });

    expect(plan.kind).toBe("mrv_call");
    expect(plan.request).toMatchObject({
      from: USER_BECH32,
      contractAddress: CONTRACT_BECH32,
      input: "0xaabbccdd",
      valueLythoshi: "42",
    });
    expect(plan.request.priorityTipLythoshi).toBeUndefined();
    expect(plan.nativeTx.priorityTipLythoshi).toBe("0");
    expect(plan.tx).toMatchObject({
      chainIdHex: "0x10f2c",
      nonceHex: "0x8",
      gasLimitHex: "0x200000",
      maxFeePerGas: "0x1312d00",
      maxPriorityFeePerGas: "0x0",
      to: CONTRACT,
      valueWeiHex: "0x2a",
      data: "0xaabbccdd",
    });
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("converts a previewed MRV call plan into an extension-carrying submit tx", () => {
    const plan = buildWalletMrvCallNativePlan({
      fromAddress: USER,
      contractAddress: CONTRACT,
      chainIdHex: "0x10f2c",
      nonceHex: "0x8",
      executionUnitLimitHex: "0x200000",
      maxExecutionFeeLythoshiHex: "0x1312d00",
      priorityTipLythoshiHex: "0x5",
      input: "0xaabbccdd",
      valueWeiHex: "0x2a",
    });

    expect(
      walletMrvNativePlanToSubmitTx(plan, {
        chainIdHex: "0x10F2C",
        fromAddress: USER,
      }),
    ).toEqual({
      to: CONTRACT,
      value: "0x2a",
      data: "0xaabbccdd",
      gas: "0x200000",
      nonce: "0x8",
      maxFeePerGas: "0x1312d00",
      maxPriorityFeePerGas: "0x5",
      chainIdHex: "0x10f2c",
      extensions: [{ kind: WALLET_MRV_TX_EXTENSION_KIND, bodyHex: "0x01" }],
    });
  });

  it("blocks submit conversion when the MRV extension is missing", () => {
    const plan = buildWalletMrvDeployNativePlan({
      fromAddress: USER,
      chainIdHex: "0x10f2c",
      nonceHex: "0x7",
      executionUnitLimitHex: "0x100000",
      maxExecutionFeeLythoshiHex: "0x989680",
      artifactBytes: "0x13000000",
    });

    expect(() =>
      walletMrvNativePlanToSubmitTx(
        { ...plan, tx: { ...plan.tx, extensions: [] } },
        { chainIdHex: "0x10f2c", fromAddress: USER },
      ),
    ).toThrow(/exactly one transaction extension/);
  });

  it("rejects non-canonical hex quantities before building a plan", () => {
    expect(() =>
      buildWalletMrvDeployNativePlan({
        fromAddress: USER,
        chainIdHex: "0x010F2C",
        nonceHex: "0x1",
        executionUnitLimitHex: "0x100",
        maxExecutionFeeLythoshiHex: "0x1",
        artifactBytes: "0x13",
      }),
    ).toThrow(/chainIdHex/);
  });
});
