import { typedBech32ToAddress } from "@monolythium/core-sdk";

export interface MrcAccountRecord {
  kind: "smart_account" | "policy_account";
  account: string;
  controller: string;
  recovery: string | null;
  policyHash: string | null;
  policy: MrcPolicyRecord | null;
  nonce: string | null;
  updatedAtBlock: number;
}

export interface MrcPolicyRecord {
  enabled: boolean;
  perActionLimit: string;
  windowLimit: string;
  allowedAssets: string[];
}

export interface MrcPolicySpendRecord {
  account: string;
  assetId: string;
  window: string;
  amount: string;
  spent: string;
  updatedAtBlock: number;
}

export interface MrcAccountLookupResponse {
  schemaVersion: 1;
  account: string;
  spendLimit: number;
  smartAccount: MrcAccountRecord | null;
  policyAccount: MrcAccountRecord | null;
  policySpends: MrcPolicySpendRecord[];
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const proto = Object.getPrototypeOf(input);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.length > 0;
}

function normalizeMrcSmartAccount(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    return typedBech32ToAddress(input, "smartAccount").address;
  } catch {
    return null;
  }
}

function normalizeUserAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    return typedBech32ToAddress(input, "user").address;
  } catch {
    return null;
  }
}

function validateBlockHeight(input: unknown): number | null {
  if (isFiniteNum(input) && Number.isSafeInteger(input) && input >= 0) {
    return input;
  }
  if (typeof input === "bigint" && input >= 0n && input <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(input);
  }
  if (typeof input === "string" && /^[0-9]+$/.test(input)) {
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function validateMrcPolicyRecord(input: unknown): MrcPolicyRecord | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return null;
  if (!isNonEmptyString(r.perActionLimit)) return null;
  if (!isNonEmptyString(r.windowLimit)) return null;
  if (!Array.isArray(r.allowedAssets)) return null;

  const allowedAssets: string[] = [];
  for (const raw of r.allowedAssets) {
    if (!isNonEmptyString(raw)) return null;
    allowedAssets.push(raw);
  }

  return {
    enabled: r.enabled,
    perActionLimit: r.perActionLimit,
    windowLimit: r.windowLimit,
    allowedAssets,
  };
}

function validateMrcAccountRecord(
  input: unknown,
  expectedKind: MrcAccountRecord["kind"],
  expectedAccount: string,
): MrcAccountRecord | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (r.kind !== expectedKind) return null;
  const account = normalizeMrcSmartAccount(r.account);
  if (account === null || account !== expectedAccount) return null;
  const controller = normalizeUserAddress(r.controller);
  if (controller === null) return null;
  let recovery: string | null;
  let policyHash: string | null;
  let policy: MrcPolicyRecord | null;
  const rawPolicy = r.policy ?? null;
  if (expectedKind === "smart_account") {
    const recoveryInput =
      r.recovery === null ? null : normalizeUserAddress(r.recovery);
    if (r.recovery !== null && recoveryInput === null) return null;
    if (r.policyHash !== null) return null;
    if (rawPolicy !== null) return null;
    recovery = recoveryInput;
    policyHash = null;
    policy = null;
  } else {
    const policyHashInput = r.policyHash;
    if (r.recovery !== null) return null;
    if (policyHashInput !== null && !isNonEmptyString(policyHashInput)) return null;
    const policyInput =
      rawPolicy === null ? null : validateMrcPolicyRecord(rawPolicy);
    if (rawPolicy !== null && policyInput === null) return null;
    recovery = null;
    policyHash = policyHashInput;
    policy = policyInput;
  }
  const nonce = r.nonce;
  if (nonce !== null && !isNonEmptyString(nonce)) return null;
  const updatedAtBlock = validateBlockHeight(r.updatedAtBlock);
  if (updatedAtBlock === null) return null;
  return {
    kind: expectedKind,
    account,
    controller,
    recovery,
    policyHash,
    policy,
    nonce,
    updatedAtBlock,
  };
}

function validateMrcPolicySpendRecord(
  input: unknown,
  expectedAccount: string,
): MrcPolicySpendRecord | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  const account = normalizeMrcSmartAccount(r.account);
  if (account === null || account !== expectedAccount) return null;
  if (!isNonEmptyString(r.assetId)) return null;
  if (!isNonEmptyString(r.window)) return null;
  if (typeof r.amount !== "string") return null;
  if (typeof r.spent !== "string") return null;
  const updatedAtBlock = validateBlockHeight(r.updatedAtBlock);
  if (updatedAtBlock === null) return null;
  return {
    account,
    assetId: r.assetId,
    window: r.window,
    amount: r.amount,
    spent: r.spent,
    updatedAtBlock,
  };
}

export function validateMrcAccountLookupResponse(
  input: unknown,
): MrcAccountLookupResponse | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  const account = normalizeMrcSmartAccount(r.account);
  if (account === null) return null;
  if (
    !isFiniteNum(r.spendLimit) ||
    !Number.isSafeInteger(r.spendLimit) ||
    r.spendLimit < 1
  ) {
    return null;
  }
  if (!Array.isArray(r.policySpends)) return null;

  const smartAccount =
    r.smartAccount === null
      ? null
      : validateMrcAccountRecord(r.smartAccount, "smart_account", account);
  if (smartAccount === null && r.smartAccount !== null) return null;

  const policyAccount =
    r.policyAccount === null
      ? null
      : validateMrcAccountRecord(r.policyAccount, "policy_account", account);
  if (policyAccount === null && r.policyAccount !== null) return null;

  const policySpends: MrcPolicySpendRecord[] = [];
  for (const raw of r.policySpends.slice(0, r.spendLimit)) {
    const row = validateMrcPolicySpendRecord(raw, account);
    if (row !== null) policySpends.push(row);
  }

  return {
    schemaVersion: 1,
    account,
    spendLimit: r.spendLimit,
    smartAccount,
    policyAccount,
    policySpends,
  };
}
