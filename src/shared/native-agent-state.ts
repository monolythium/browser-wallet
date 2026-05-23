export type NativeAgentStateJsonValue =
  | string
  | number
  | boolean
  | null
  | NativeAgentStateJsonValue[]
  | { [key: string]: NativeAgentStateJsonValue };

export type NativeAgentStateRow = Record<string, NativeAgentStateJsonValue>;

export interface NativeAgentStateFilter {
  policyId?: string;
  escrowId?: string;
  account?: string;
  includePolicySpends?: boolean;
  limit?: number;
}

export interface NativeAgentStateResponse {
  schemaVersion: number;
  limit: number;
  filters: NativeAgentStateRow;
  issuers: NativeAgentStateRow[];
  attestations: NativeAgentStateRow[];
  consents: NativeAgentStateRow[];
  services: NativeAgentStateRow[];
  availability: NativeAgentStateRow[];
  arbiters: NativeAgentStateRow[];
  reputationReviews: NativeAgentStateRow[];
  spendingPolicies: NativeAgentStateRow[];
  policySpends: NativeAgentStateRow[];
  escrows: NativeAgentStateRow[];
  source: NativeAgentStateRow | null;
}

const MAX_JSON_DEPTH = 6;
const MAX_JSON_KEYS = 96;
const MAX_JSON_KEY_LENGTH = 96;
const MAX_JSON_STRING_LENGTH = 2048;
const MAX_JSON_ARRAY_ITEMS = 250;

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const proto = Object.getPrototypeOf(input);
  return proto === Object.prototype || proto === null;
}

function validateJsonValue(
  input: unknown,
  depth: number,
): NativeAgentStateJsonValue | undefined {
  if (input === null) return null;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input === "string") {
    return input.length <= MAX_JSON_STRING_LENGTH ? input : undefined;
  }
  if (depth >= MAX_JSON_DEPTH) return undefined;

  if (Array.isArray(input)) {
    if (input.length > MAX_JSON_ARRAY_ITEMS) return undefined;
    const out: NativeAgentStateJsonValue[] = [];
    for (const item of input) {
      const value = validateJsonValue(item, depth + 1);
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  }

  if (!isPlainRecord(input)) return undefined;
  return validateNativeAgentStateRow(input, depth + 1) ?? undefined;
}

function validateNativeAgentStateRow(
  input: unknown,
  depth = 0,
): NativeAgentStateRow | null {
  if (!isPlainRecord(input)) return null;
  const entries = Object.entries(input);
  if (entries.length > MAX_JSON_KEYS) return null;
  const out: NativeAgentStateRow = {};
  for (const [key, rawValue] of entries) {
    if (key.length === 0 || key.length > MAX_JSON_KEY_LENGTH) return null;
    const value = validateJsonValue(rawValue, depth + 1);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

function validateNativeAgentStateRows(input: unknown): NativeAgentStateRow[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_JSON_ARRAY_ITEMS) return null;
  const out: NativeAgentStateRow[] = [];
  for (const item of input) {
    const row = validateNativeAgentStateRow(item);
    if (row === null) return null;
    out.push(row);
  }
  return out;
}

function readRows(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): NativeAgentStateRow[] | null {
  const raw = Object.prototype.hasOwnProperty.call(record, camelKey)
    ? record[camelKey]
    : record[snakeKey];
  return validateNativeAgentStateRows(raw);
}

function readOptionalRows(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): NativeAgentStateRow[] | null {
  const hasCamel = Object.prototype.hasOwnProperty.call(record, camelKey);
  const hasSnake = Object.prototype.hasOwnProperty.call(record, snakeKey);
  if (!hasCamel && !hasSnake) return [];
  const raw = hasCamel ? record[camelKey] : record[snakeKey];
  return validateNativeAgentStateRows(raw);
}

export function validateNativeAgentStateResponse(
  input: unknown,
): NativeAgentStateResponse | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (
    typeof r.schemaVersion !== "number" ||
    !Number.isSafeInteger(r.schemaVersion) ||
    r.schemaVersion < 1
  ) {
    return null;
  }
  if (
    typeof r.limit !== "number" ||
    !Number.isSafeInteger(r.limit) ||
    r.limit < 0
  ) {
    return null;
  }

  const filters = validateNativeAgentStateRow(r.filters ?? {});
  const source =
    r.source === undefined || r.source === null
      ? null
      : validateNativeAgentStateRow(r.source);
  const issuers = readOptionalRows(r, "issuers", "issuers");
  const attestations = readOptionalRows(r, "attestations", "attestations");
  const consents = readOptionalRows(r, "consents", "consents");
  const services = readOptionalRows(r, "services", "services");
  const availability = readOptionalRows(r, "availability", "availability");
  const arbiters = readOptionalRows(r, "arbiters", "arbiters");
  const reputationReviews = readOptionalRows(
    r,
    "reputationReviews",
    "reputation_reviews",
  );
  const spendingPolicies = readRows(r, "spendingPolicies", "spending_policies");
  const policySpends = readRows(r, "policySpends", "policy_spends");
  const escrows = readRows(r, "escrows", "escrows");

  if (
    filters === null ||
    source === null && r.source !== undefined && r.source !== null ||
    issuers === null ||
    attestations === null ||
    consents === null ||
    services === null ||
    availability === null ||
    arbiters === null ||
    reputationReviews === null ||
    spendingPolicies === null ||
    policySpends === null ||
    escrows === null
  ) {
    return null;
  }

  return {
    schemaVersion: r.schemaVersion,
    limit: r.limit,
    filters,
    issuers,
    attestations,
    consents,
    services,
    availability,
    arbiters,
    reputationReviews,
    spendingPolicies,
    policySpends,
    escrows,
    source,
  };
}

export function buildNativeAgentStateRpcFilter(
  input: NativeAgentStateFilter = {},
): NativeAgentStateFilter {
  const out: NativeAgentStateFilter = {};
  const policyId =
    typeof input.policyId === "string" && input.policyId.length > 0
      ? input.policyId
      : null;
  const escrowId =
    policyId === null &&
    typeof input.escrowId === "string" &&
    input.escrowId.length > 0
      ? input.escrowId
      : null;
  const account =
    policyId === null &&
    escrowId === null &&
    typeof input.account === "string" &&
    input.account.length > 0
      ? input.account
      : null;

  if (policyId !== null) out.policyId = policyId;
  if (escrowId !== null) out.escrowId = escrowId;
  if (account !== null) out.account = account;
  if (
    (policyId !== null || account !== null) &&
    typeof input.includePolicySpends === "boolean"
  ) {
    out.includePolicySpends = input.includePolicySpends;
  }
  if (
    typeof input.limit === "number" &&
    Number.isSafeInteger(input.limit) &&
    input.limit >= 0
  ) {
    out.limit = input.limit;
  }
  return out;
}
