import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MrvNative,
  MrvNativePlanPreview,
  buildMrvNativeRequest,
  coerceHexQuantityInput,
  type MrvNativeFormValues,
} from "./MrvNative.js";
import type { WalletMrvNativeSubmissionPlan } from "../bg.js";

const BASE_FORM: MrvNativeFormValues = {
  artifactBytes: "0x13000000",
  artifactHash: "",
  contractAddress: "0x2222222222222222222222222222222222222222",
  callInput: "0xaabbccdd",
  executionUnitLimit: "2097152",
  maxExecutionFeeLythoshi: "10000000",
  priorityTipLythoshi: "",
  valueLythoshi: "42",
};

describe("MrvNative", () => {
  it("renders the v4.1 MRV native preview and honest submit scope", () => {
    const html = renderToStaticMarkup(
      <MrvNative chainIdHex="0x10F2C" onBack={() => undefined} />,
    );

    expect(html).toContain("MRV native");
    expect(html).toContain("Native contract preview");
    expect(html).toContain("execution units");
    expect(html).toContain("lythoshi");
    expect(html).toContain("typed addresses");
    expect(html).toContain("does not confirm or prove live MRV execution");
  });

  it("renders returned JSON-safe plans with native contract and fee terms", () => {
    const plan: WalletMrvNativeSubmissionPlan = {
      kind: "mrv_call",
      request: {
        from: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
        contractAddress: "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd",
        input: "0xaabbccdd",
        valueLythoshi: "42",
        executionUnitLimit: "2097152",
        maxExecutionFeeLythoshi: "10000000",
        priorityTipLythoshi: "5",
        nonce: "8",
      },
      extension: { kind: 1, bodyHex: "0x02aabbccdd" },
      nativeTx: {
        chainId: "69420",
        nonce: "8",
        valueLythoshi: "42",
        executionUnitLimit: "2097152",
        maxExecutionFeeLythoshi: "10000000",
        priorityTipLythoshi: "5",
      },
      feePreview: {
        totalLythoshi: "20971520000042",
        totalLyth: "209715.20000042",
        cyclesUsed: "2097152",
        executionUnitLimit: "2097152",
        maxExecutionFeeLythoshi: "10000000",
        priorityTipLythoshi: "5",
      },
      tx: {
        chainIdHex: "0x10f2c",
        nonceHex: "0x8",
        gasLimitHex: "0x200000",
        maxFeePerGas: "0x989680",
        maxPriorityFeePerGas: "0x5",
        to: "0x2222222222222222222222222222222222222222",
        valueWeiHex: "0x2a",
        data: "0xaabbccdd",
        extensions: [{ kind: 1, bodyHex: "0x02aabbccdd" }],
      },
    };

    const html = renderToStaticMarkup(<MrvNativePlanPreview plan={plan} />);

    expect(html).toContain("Native contract");
    expect(html).toContain("Typed user address");
    expect(html).toContain("2097152");
    expect(html).toContain("10000000 lythoshi");
    expect(html).toContain("JSON-safe plan");
    expect(html).toContain("monoc1yg3");
  });

  it("renders a submit-ready preview action without claiming confirmation", () => {
    const plan: WalletMrvNativeSubmissionPlan = {
      kind: "mrv_deploy",
      request: {
        from: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
        artifactBytes: "0x13000000",
        valueLythoshi: "0",
        executionUnitLimit: "1000000",
        maxExecutionFeeLythoshi: "100",
        priorityTipLythoshi: "1",
        nonce: "7",
      },
      extension: { kind: 48, bodyHex: "0x01" },
      expectedContractAddress: "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd",
      nativeTx: {
        chainId: "69420",
        nonce: "7",
        valueLythoshi: "0",
        executionUnitLimit: "1000000",
        maxExecutionFeeLythoshi: "100",
        priorityTipLythoshi: "1",
      },
      feePreview: {
        totalLythoshi: "100",
        totalLyth: "0.000001",
        cyclesUsed: "1000000",
        executionUnitLimit: "1000000",
        maxExecutionFeeLythoshi: "100",
        priorityTipLythoshi: "1",
      },
      tx: {
        chainIdHex: "0x10f2c",
        nonceHex: "0x7",
        gasLimitHex: "0xf4240",
        maxFeePerGas: "0x64",
        maxPriorityFeePerGas: "0x1",
        to: null,
        valueWeiHex: "0x0",
        data: "0x13000000",
        extensions: [{ kind: 48, bodyHex: "0x01" }],
      },
    };

    const readyHtml = renderToStaticMarkup(
      <MrvNativePlanPreview plan={plan} onSubmit={() => undefined} />,
    );
    expect(readyHtml).toContain("Sign and submit");

    const html = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: `0x${"a".repeat(64)}`, via: "mock-operator" }}
      />,
    );

    expect(html).toContain("Transaction submitted");
    expect(html).toContain("mock-operator");
    expect(html).toContain("Awaiting chain confirmation");
    expect(html).toContain("has not verified MRV");
  });
});

describe("buildMrvNativeRequest", () => {
  it("builds deploy payloads with canonical execution-unit and lythoshi quantities", () => {
    const req = buildMrvNativeRequest("deploy", BASE_FORM, "0x10F2C");

    expect(req).toEqual({
      ok: true,
      mode: "deploy",
      args: {
        artifactBytes: "0x13000000",
        chainIdHex: "0x10f2c",
        executionUnitLimitHex: "0x200000",
        maxExecutionFeeLythoshiHex: "0x989680",
        valueWeiHex: "0x2a",
      },
    });
  });

  it("builds call payloads for native contract typed-address normalization in the background", () => {
    const req = buildMrvNativeRequest("call", BASE_FORM, "0x10F2C");

    expect(req).toEqual({
      ok: true,
      mode: "call",
      args: {
        contractAddress: "0x2222222222222222222222222222222222222222",
        input: "0xaabbccdd",
        chainIdHex: "0x10f2c",
        executionUnitLimitHex: "0x200000",
        maxExecutionFeeLythoshiHex: "0x989680",
        valueWeiHex: "0x2a",
      },
    });
  });

  it("rejects missing deploy artifact bytes before IPC", () => {
    const req = buildMrvNativeRequest(
      "deploy",
      { ...BASE_FORM, artifactBytes: "" },
      "0x10F2C",
    );

    expect(req).toEqual({ ok: false, reason: "artifact bytes is required" });
  });
});

describe("coerceHexQuantityInput", () => {
  it("accepts decimal or 0x input and emits canonical lowercase hex quantities", () => {
    expect(
      coerceHexQuantityInput("1000000", "execution unit limit", {
        required: true,
        allowZero: false,
      }),
    ).toEqual({ ok: true, value: "0xf4240" });
    expect(
      coerceHexQuantityInput("0x000F", "priority tip lythoshi", {
        required: false,
        allowZero: true,
      }),
    ).toEqual({ ok: true, value: "0xf" });
  });

  it("rejects fractional lythoshi values", () => {
    expect(
      coerceHexQuantityInput("1.5", "value lythoshi", {
        required: false,
        allowZero: true,
      }),
    ).toEqual({
      ok: false,
      reason: "value lythoshi must be a non-negative integer or 0x hex quantity",
    });
  });
});
