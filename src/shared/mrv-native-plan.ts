import {
  MRV_TX_EXTENSION_KIND,
  addressToTypedBech32,
  buildMrvCallNativeTxPlan,
  buildMrvDeployNativeTxPlan,
  typedBech32ToAddress,
  type MrvCallNativeTxPlan,
  type MrvDeployNativeTxPlan,
} from "@monolythium/core-sdk";

export const WALLET_MRV_TX_EXTENSION_KIND = MRV_TX_EXTENSION_KIND;

export interface WalletMrvNativePlanBaseInput {
  fromAddress: string;
  chainIdHex: string;
  nonceHex: string;
  executionUnitLimitHex: string;
  maxExecutionFeeLythoshiHex: string;
  priorityTipLythoshiHex?: string;
  valueWeiHex?: string;
}

export interface WalletMrvDeployNativePlanInput extends WalletMrvNativePlanBaseInput {
  artifactBytes: string;
  artifactHash?: string;
}

export interface WalletMrvCallNativePlanInput extends WalletMrvNativePlanBaseInput {
  contractAddress: string;
  input: string;
}

export interface WalletMrvSerializedRequest {
  from?: string;
  artifactBytes?: string;
  contractAddress?: string;
  input?: string;
  valueLythoshi: string;
  executionUnitLimit?: string;
  maxExecutionFeeLythoshi?: string;
  priorityTipLythoshi?: string;
  nonce?: string;
}

export interface WalletMrvSerializedNativeTx {
  chainId: string;
  nonce: string;
  valueLythoshi: string;
  executionUnitLimit: string;
  maxExecutionFeeLythoshi: string;
  priorityTipLythoshi: string;
}

export interface WalletMrvSerializedFeePreview {
  totalLythoshi: string;
  totalLyth: string;
  cyclesUsed: string;
  executionUnitLimit: string;
  maxExecutionFeeLythoshi: string;
  priorityTipLythoshi: string;
}

export interface WalletMrvSerializedTx {
  chainIdHex: string;
  nonceHex: string;
  gasLimitHex: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  to: string | null;
  valueWeiHex: string;
  data: string;
  extensions: WalletMrvTransactionExtension[];
}

export interface WalletMrvTransactionExtension {
  kind: number;
  bodyHex: string;
}

export interface WalletMrvNativeSubmissionPlan {
  kind: "mrv_deploy" | "mrv_call";
  request: WalletMrvSerializedRequest;
  extension: WalletMrvTransactionExtension;
  expectedContractAddress?: string;
  nativeTx: WalletMrvSerializedNativeTx;
  feePreview: WalletMrvSerializedFeePreview;
  tx: WalletMrvSerializedTx;
}

export function buildWalletMrvDeployNativePlan(
  input: WalletMrvDeployNativePlanInput,
): WalletMrvNativeSubmissionPlan {
  const from = normalizeUserAddress(input.fromAddress);
  const options = {
    from,
    chainId: hexQuantityToBigint(input.chainIdHex, "chainIdHex"),
    nonce: hexQuantityToBigint(input.nonceHex, "nonceHex"),
    executionUnitLimit: hexQuantityToBigint(
      input.executionUnitLimitHex,
      "executionUnitLimitHex",
    ),
    maxExecutionFeeLythoshi: hexQuantityToBigint(
      input.maxExecutionFeeLythoshiHex,
      "maxExecutionFeeLythoshiHex",
    ),
    valueLythoshi: hexQuantityToBigint(input.valueWeiHex ?? "0x0", "valueWeiHex"),
    ...(input.priorityTipLythoshiHex !== undefined
      ? {
          priorityTipLythoshi: hexQuantityToBigint(
            input.priorityTipLythoshiHex,
            "priorityTipLythoshiHex",
          ),
        }
      : {}),
    ...(input.artifactHash !== undefined ? { artifactHash: input.artifactHash } : {}),
  };
  return serializeSdkPlan("mrv_deploy", buildMrvDeployNativeTxPlan(input.artifactBytes, options));
}

export function buildWalletMrvCallNativePlan(
  input: WalletMrvCallNativePlanInput,
): WalletMrvNativeSubmissionPlan {
  const options = {
    from: normalizeUserAddress(input.fromAddress),
    chainId: hexQuantityToBigint(input.chainIdHex, "chainIdHex"),
    nonce: hexQuantityToBigint(input.nonceHex, "nonceHex"),
    executionUnitLimit: hexQuantityToBigint(
      input.executionUnitLimitHex,
      "executionUnitLimitHex",
    ),
    maxExecutionFeeLythoshi: hexQuantityToBigint(
      input.maxExecutionFeeLythoshiHex,
      "maxExecutionFeeLythoshiHex",
    ),
    valueLythoshi: hexQuantityToBigint(input.valueWeiHex ?? "0x0", "valueWeiHex"),
    ...(input.priorityTipLythoshiHex !== undefined
      ? {
          priorityTipLythoshi: hexQuantityToBigint(
            input.priorityTipLythoshiHex,
            "priorityTipLythoshiHex",
          ),
        }
      : {}),
  };
  return serializeSdkPlan(
    "mrv_call",
    buildMrvCallNativeTxPlan(normalizeContractAddress(input.contractAddress).typed, input.input, options),
  );
}

function serializeSdkPlan(
  kind: "mrv_deploy",
  plan: MrvDeployNativeTxPlan,
): WalletMrvNativeSubmissionPlan;
function serializeSdkPlan(
  kind: "mrv_call",
  plan: MrvCallNativeTxPlan,
): WalletMrvNativeSubmissionPlan;
function serializeSdkPlan(
  kind: "mrv_deploy" | "mrv_call",
  plan: MrvDeployNativeTxPlan | MrvCallNativeTxPlan,
): WalletMrvNativeSubmissionPlan {
  const request: WalletMrvSerializedRequest = {
    valueLythoshi: plan.request.valueLythoshi,
    ...(plan.request.from !== undefined ? { from: plan.request.from } : {}),
    ...(plan.request.executionUnitLimit !== undefined
      ? { executionUnitLimit: plan.request.executionUnitLimit.toString() }
      : {}),
    ...(plan.request.maxExecutionFeeLythoshi !== undefined
      ? { maxExecutionFeeLythoshi: plan.request.maxExecutionFeeLythoshi }
      : {}),
    ...(plan.request.priorityTipLythoshi !== undefined
      ? { priorityTipLythoshi: plan.request.priorityTipLythoshi }
      : {}),
    ...(plan.request.nonce !== undefined ? { nonce: plan.request.nonce.toString() } : {}),
  };
  if (kind === "mrv_deploy") {
    const deployRequest = (plan as MrvDeployNativeTxPlan).request;
    if (deployRequest.artifactBytes !== undefined) {
      request.artifactBytes = deployRequest.artifactBytes;
    }
  } else {
    const callRequest = (plan as MrvCallNativeTxPlan).request;
    if (callRequest.contractAddress !== undefined) {
      request.contractAddress = callRequest.contractAddress;
    }
    if (callRequest.input !== undefined) {
      request.input = callRequest.input;
    }
  }
  return {
    kind,
    request,
    extension: serializeExtension(plan.extension),
    ...(kind === "mrv_deploy" && "expectedContractAddress" in plan && plan.expectedContractAddress
      ? { expectedContractAddress: plan.expectedContractAddress }
      : {}),
    nativeTx: {
      chainId: plan.nativeTx.chainId.toString(),
      nonce: plan.nativeTx.nonce.toString(),
      valueLythoshi: plan.nativeTx.valueLythoshi,
      executionUnitLimit: plan.nativeTx.executionUnitLimit.toString(),
      maxExecutionFeeLythoshi: plan.nativeTx.maxExecutionFeeLythoshi,
      priorityTipLythoshi: plan.nativeTx.priorityTipLythoshi,
    },
    feePreview: {
      totalLythoshi: plan.feePreview.totalLythoshi,
      totalLyth: plan.feePreview.totalLyth,
      cyclesUsed: plan.feePreview.cyclesUsed.toString(),
      executionUnitLimit: plan.feePreview.executionUnitLimit.toString(),
      maxExecutionFeeLythoshi: plan.feePreview.maxExecutionFeeLythoshi,
      priorityTipLythoshi: plan.feePreview.priorityTipLythoshi,
    },
    tx: {
      chainIdHex: bigintToHexQuantity(BigInt(plan.tx.chainId)),
      nonceHex: bigintToHexQuantity(BigInt(plan.tx.nonce)),
      gasLimitHex: bigintToHexQuantity(BigInt(plan.tx.gasLimit)),
      maxFeePerGas: bigintToHexQuantity(BigInt(plan.tx.maxFeePerGas)),
      maxPriorityFeePerGas: bigintToHexQuantity(BigInt(plan.tx.maxPriorityFeePerGas)),
      to: plan.tx.to === null ? null : normalizeAddressHex(String(plan.tx.to)),
      valueWeiHex: bigintToHexQuantity(BigInt(plan.tx.value)),
      data: normalizeHexBytes(String(plan.tx.input ?? "0x"), "tx.input"),
      extensions: (plan.tx.extensions ?? []).map(serializeExtension),
    },
  };
}

function normalizeUserAddress(address: string): string {
  if (address.startsWith("0x") || address.startsWith("0X")) {
    return addressToTypedBech32("user", address);
  }
  return typedBech32ToAddress(address, "user").address;
}

function normalizeContractAddress(address: string): { typed: string; hex: string } {
  if (address.startsWith("0x") || address.startsWith("0X")) {
    return {
      typed: addressToTypedBech32("contract", address),
      hex: normalizeAddressHex(address),
    };
  }
  const parsed = typedBech32ToAddress(address, "contract");
  return { typed: parsed.address, hex: parsed.hex };
}

function serializeExtension(extension: { kind: number; bodyHex?: string; body?: unknown }): WalletMrvTransactionExtension {
  if (typeof extension.bodyHex === "string") {
    return { kind: extension.kind, bodyHex: normalizeHexBytes(extension.bodyHex, "extension.bodyHex") };
  }
  throw new Error("MRV transaction extension must expose bodyHex");
}

function hexQuantityToBigint(value: string, field: string): bigint {
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical 0x hex quantity`);
  }
  return BigInt(value);
}

function bigintToHexQuantity(value: bigint): string {
  if (value < 0n) throw new Error("hex quantity cannot be negative");
  return `0x${value.toString(16)}`;
}

function normalizeHexBytes(value: string, field: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`${field} must be even-length 0x-prefixed hex bytes`);
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

function normalizeAddressHex(address: string): string {
  const parsed = address.startsWith("0x") || address.startsWith("0X")
    ? address
    : typedBech32ToAddress(address).hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(parsed)) {
    throw new Error("expected 0x-prefixed 20-byte hex address");
  }
  return `0x${parsed.slice(2).toLowerCase()}`;
}
