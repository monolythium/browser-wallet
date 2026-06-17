import {
  MRV_TX_EXTENSION_KIND,
  addressToTypedBech32,
  buildMrvCallNativeTxPlan,
  buildMrvDeployNativeTxPlan,
  typedBech32ToAddress,
  type MrvCallNativeTxPlan,
  type MrvDeployNativeTxPlan,
  type NativeDevApprovalKind,
  type NativeDevRiskLabel,
} from "@monolythium/core-sdk";

export const WALLET_MRV_TX_EXTENSION_KIND = MRV_TX_EXTENSION_KIND;

// The wallet, DevKit, and Studio all describe an MRV approval with the same
// review-shaped vocabulary. We re-export the SDK contract types here so the
// wallet's approval bus, the popup review panel, and any sidecar-originated
// request stay aligned on one shape rather than the thinner local plan that
// preceded this. `NativeDevApprovalKind` is the canonical discriminant; the
// wallet only ever submits the `mrv_deploy` / `mrv_call` arms today.
export type {
  NativeDevApprovalKind,
  NativeDevMrvDeployPlan,
  NativeDevRiskLabel,
  NativeDevRiskSeverity,
  NativeDevWalletApprovalRequest,
} from "@monolythium/core-sdk";

/** The MRV submission plan discriminant — a strict subset of the SDK's
 *  `NativeDevApprovalKind` (the wallet never submits token-create or
 *  verification-publish plans directly). */
export type WalletMrvApprovalKind = Extract<NativeDevApprovalKind, "mrv_deploy" | "mrv_call">;

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
  /** Deploy-vs-call discriminant — aligned with `WalletMrvApprovalKind`. */
  kind: WalletMrvApprovalKind;
  request: WalletMrvSerializedRequest;
  extension: WalletMrvTransactionExtension;
  expectedContractAddress?: string;
  nativeTx: WalletMrvSerializedNativeTx;
  feePreview: WalletMrvSerializedFeePreview;
  tx: WalletMrvSerializedTx;
  /**
   * Review-shaped fields shared with DevKit / Studio (see
   * `NativeDevMrvDeployPlan`). All optional so existing callers and persisted
   * plans remain valid; the typed MRV approval populates them when available.
   */
  /** BLAKE3 artifact hash of the deploy bytecode (deploy only). */
  artifactHash?: string;
  /** Constructor / call calldata, `0x`-hex. For deploy this is the constructor
   *  input appended to the artifact; for call it is the method calldata. */
  constructorInput?: string;
  /** Risk labels surfaced to the approver, mirroring the SDK review contract. */
  riskLabels?: NativeDevRiskLabel[];
}

export interface WalletMrvNativeSubmitTxFields {
  to?: string;
  value: string;
  data: string;
  gas: string;
  nonce: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  chainIdHex: string;
  extensions: WalletMrvTransactionExtension[];
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
  return serializeSdkPlan("mrv_deploy", buildMrvDeployNativeTxPlan(input.artifactBytes, options), {
    ...(input.artifactHash !== undefined ? { artifactHash: input.artifactHash } : {}),
  });
}

export function buildWalletMrvCallNativePlan(
  input: WalletMrvCallNativePlanInput,
): WalletMrvNativeSubmissionPlan {
  const contractAddress = requireTypedMrvContractAddress(input.contractAddress);
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
    buildMrvCallNativeTxPlan(contractAddress.typed, input.input, options),
  );
}

export function walletMrvNativePlanToSubmitTx(
  plan: WalletMrvNativeSubmissionPlan,
  opts: { chainIdHex: string; fromAddress: string },
): WalletMrvNativeSubmitTxFields {
  if (plan === null || typeof plan !== "object") {
    throw new Error("MRV native submission plan is required");
  }
  if (plan.request === null || typeof plan.request !== "object") {
    throw new Error("MRV native submission plan request is required");
  }
  if (plan.nativeTx === null || typeof plan.nativeTx !== "object") {
    throw new Error("MRV native submission plan nativeTx is required");
  }
  if (plan.tx === null || typeof plan.tx !== "object") {
    throw new Error("MRV native submission plan tx is required");
  }
  const activeChainIdHex = canonicalHexQuantityString(opts.chainIdHex, "chainIdHex");
  const txChainIdHex = canonicalHexQuantityString(plan.tx.chainIdHex, "tx.chainIdHex");
  if (txChainIdHex !== activeChainIdHex) {
    throw new Error("MRV native submission plan chainId does not match active chain");
  }
  assertDecimalMatchesHex(plan.nativeTx.chainId, txChainIdHex, "nativeTx.chainId");

  const expectedFrom = addressToTypedBech32("user", opts.fromAddress);
  if (plan.request.from !== expectedFrom) {
    throw new Error("MRV native submission plan from address does not match unlocked wallet");
  }

  assertDecimalMatchesHex(plan.nativeTx.nonce, plan.tx.nonceHex, "nativeTx.nonce");
  assertDecimalMatchesHex(
    plan.nativeTx.executionUnitLimit,
    plan.tx.gasLimitHex,
    "nativeTx.executionUnitLimit",
  );
  assertDecimalMatchesHex(
    plan.nativeTx.maxExecutionFeeLythoshi,
    plan.tx.maxFeePerGas,
    "nativeTx.maxExecutionFeeLythoshi",
  );
  assertDecimalMatchesHex(
    plan.nativeTx.priorityTipLythoshi,
    plan.tx.maxPriorityFeePerGas,
    "nativeTx.priorityTipLythoshi",
  );
  assertDecimalMatchesHex(
    plan.nativeTx.valueLythoshi,
    plan.tx.valueWeiHex,
    "nativeTx.valueLythoshi",
  );
  if (plan.request.valueLythoshi !== plan.nativeTx.valueLythoshi) {
    throw new Error("MRV native submission plan request value must match nativeTx");
  }

  const extension = assertMrvV1SerializedExtension(plan.extension, "extension");
  if (!Array.isArray(plan.tx.extensions) || plan.tx.extensions.length !== 1) {
    throw new Error("MRV native submission plan must carry exactly one transaction extension");
  }
  const txExtension = assertMrvV1SerializedExtension(
    plan.tx.extensions[0]!,
    "tx.extensions[0]",
  );
  if (
    txExtension.kind !== extension.kind ||
    txExtension.bodyHex !== extension.bodyHex
  ) {
    throw new Error("MRV native submission plan tx extension must match extension");
  }

  if (plan.kind === "mrv_deploy") {
    if (plan.tx.to !== null) {
      throw new Error("MRV deploy submission tx.to must be null");
    }
    const artifactBytes = normalizeHexBytes(
      plan.request.artifactBytes ?? "",
      "request.artifactBytes",
    );
    const txData = normalizeHexBytes(plan.tx.data, "tx.data");
    if (artifactBytes.length <= 2) {
      throw new Error("MRV deploy submission artifactBytes cannot be empty");
    }
    if (txData !== artifactBytes) {
      throw new Error("MRV deploy submission tx.data must match artifactBytes");
    }
  } else if (plan.kind === "mrv_call") {
    if (plan.tx.to === null) {
      throw new Error("MRV call submission tx.to must be a contract address");
    }
    const contractAddress = plan.request.contractAddress;
    if (typeof contractAddress !== "string") {
      throw new Error("MRV call submission request.contractAddress is required");
    }
    const expectedTo = typedBech32ToAddress(contractAddress, "contract").hex.toLowerCase();
    if (normalizeAddressHex(plan.tx.to) !== expectedTo) {
      throw new Error("MRV call submission tx.to must match contractAddress");
    }
    const input = normalizeHexBytes(plan.request.input ?? "", "request.input");
    if (normalizeHexBytes(plan.tx.data, "tx.data") !== input) {
      throw new Error("MRV call submission tx.data must match request input");
    }
  } else {
    throw new Error("unsupported MRV native submission plan kind");
  }

  return {
    ...(plan.tx.to !== null ? { to: normalizeAddressHex(plan.tx.to) } : {}),
    value: canonicalHexQuantityString(plan.tx.valueWeiHex, "tx.valueWeiHex"),
    data: normalizeHexBytes(plan.tx.data, "tx.data"),
    gas: canonicalHexQuantityString(plan.tx.gasLimitHex, "tx.gasLimitHex"),
    nonce: canonicalHexQuantityString(plan.tx.nonceHex, "tx.nonceHex"),
    maxFeePerGas: canonicalHexQuantityString(
      plan.tx.maxFeePerGas,
      "tx.maxFeePerGas",
    ),
    maxPriorityFeePerGas: canonicalHexQuantityString(
      plan.tx.maxPriorityFeePerGas,
      "tx.maxPriorityFeePerGas",
    ),
    chainIdHex: txChainIdHex,
    extensions: [txExtension],
  };
}

/** Review-shaped extras the SDK plan does not surface back (they are build
 *  inputs). Threaded in so the wallet's typed approval carries them. */
interface MrvPlanReviewExtras {
  artifactHash?: string;
}

function serializeSdkPlan(
  kind: "mrv_deploy",
  plan: MrvDeployNativeTxPlan,
  review?: MrvPlanReviewExtras,
): WalletMrvNativeSubmissionPlan;
function serializeSdkPlan(
  kind: "mrv_call",
  plan: MrvCallNativeTxPlan,
  review?: MrvPlanReviewExtras,
): WalletMrvNativeSubmissionPlan;
function serializeSdkPlan(
  kind: "mrv_deploy" | "mrv_call",
  plan: MrvDeployNativeTxPlan | MrvCallNativeTxPlan,
  review: MrvPlanReviewExtras = {},
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
  const expectedContractAddress =
    kind === "mrv_deploy" && "expectedContractAddress" in plan
      ? plan.expectedContractAddress
      : undefined;
  // The calldata the chain executes: for a deploy this is the artifact (with
  // any constructor payload appended); for a call it is the method calldata.
  const constructorInput =
    kind === "mrv_deploy"
      ? request.artifactBytes ?? normalizeHexBytes(String(plan.tx.input ?? "0x"), "tx.input")
      : request.input;
  const riskLabels = deriveMrvRiskLabels(kind, {
    valueLythoshi: plan.nativeTx.valueLythoshi,
  });
  return {
    kind,
    request,
    extension: serializeExtension(plan.extension),
    ...(expectedContractAddress ? { expectedContractAddress } : {}),
    ...(review.artifactHash !== undefined ? { artifactHash: review.artifactHash } : {}),
    ...(constructorInput !== undefined ? { constructorInput } : {}),
    ...(riskLabels.length > 0 ? { riskLabels } : {}),
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

/**
 * Derive the risk labels surfaced on the MRV approval. These are intentionally
 * conservative, schema-aligned signals (same `NativeDevRiskLabel` shape the
 * DevKit/Studio review path uses) so the wallet can render risk chips without
 * a sidecar round-trip. The chain remains the authority; these are advisory.
 */
function deriveMrvRiskLabels(
  kind: WalletMrvApprovalKind,
  ctx: { valueLythoshi: string },
): NativeDevRiskLabel[] {
  const labels: NativeDevRiskLabel[] = [];
  if (kind === "mrv_deploy") {
    labels.push({
      id: "mrv.deploy.new-contract",
      title: "Deploys a new contract",
      severity: "info",
      detail:
        "Publishes RISC-V bytecode to a freshly derived contract address. Review the artifact hash before approving.",
    });
  } else {
    labels.push({
      id: "mrv.call.executes-code",
      title: "Executes contract code",
      severity: "info",
      detail:
        "Invokes a method on an existing native contract. Calldata is shown verbatim below.",
    });
  }
  if (isNonZeroDecimal(ctx.valueLythoshi)) {
    labels.push({
      id: "mrv.value.transfers-funds",
      title: "Transfers value",
      severity: "warning",
      detail: "This transaction moves a non-zero LYTH value alongside the contract action.",
    });
  }
  return labels;
}

function isNonZeroDecimal(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  try {
    return decimalStringToBigint(value, "valueLythoshi") > 0n;
  } catch {
    return false;
  }
}

function normalizeUserAddress(address: string): string {
  if (address.startsWith("0x") || address.startsWith("0X")) {
    return addressToTypedBech32("user", address);
  }
  return typedBech32ToAddress(address, "user").address;
}

export function requireTypedMrvContractAddress(address: string): { typed: string; hex: string } {
  const value = address.trim();
  if (value.startsWith("0x") || value.startsWith("0X")) {
    throw new Error("MRV native contractAddress raw 0x addresses are retired; use a typed monoc1 address");
  }
  try {
    const parsed = typedBech32ToAddress(value, "contract");
    return { typed: parsed.address, hex: parsed.hex };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`MRV native contractAddress must be a typed monoc1 address: ${message}`);
  }
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

function canonicalHexQuantityString(value: string, field: string): string {
  return bigintToHexQuantity(hexQuantityToBigint(value, field));
}

function decimalStringToBigint(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a decimal integer string`);
  }
  return BigInt(value);
}

function assertDecimalMatchesHex(
  decimal: string,
  hex: string,
  field: string,
): void {
  if (decimalStringToBigint(decimal, field) !== hexQuantityToBigint(hex, field)) {
    throw new Error(`${field} must match tx`);
  }
}

function assertMrvV1SerializedExtension(
  extension: WalletMrvTransactionExtension,
  field: string,
): WalletMrvTransactionExtension {
  if (extension === null || typeof extension !== "object") {
    throw new Error(`${field} is required`);
  }
  if (extension.kind !== WALLET_MRV_TX_EXTENSION_KIND) {
    throw new Error(`${field}.kind must be MRV v1 extension kind`);
  }
  const bodyHex = normalizeHexBytes(extension.bodyHex, `${field}.bodyHex`);
  if (bodyHex !== "0x01") {
    throw new Error(`${field}.bodyHex must be MRV v1 extension body`);
  }
  return { kind: extension.kind, bodyHex };
}
