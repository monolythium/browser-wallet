export interface WalletTokenBalanceMrcIdentity {
  standard: string;
  assetId: string;
  tokenId?: string;
}

export type WalletBridgeDisclosureValue =
  | string
  | number
  | boolean
  | null
  | WalletBridgeDisclosureValue[]
  | { [key: string]: WalletBridgeDisclosureValue };

export type WalletBridgeRouteDisclosure = Record<
  string,
  WalletBridgeDisclosureValue
>;

export interface WalletTokenBalance {
  tokenId: string;
  balance: string;
  updatedAtBlock: number;
  mrc?: WalletTokenBalanceMrcIdentity;
  bridgeRouteDisclosure?: WalletBridgeRouteDisclosure;
  bridgeRouteDisclosures?: WalletBridgeRouteDisclosure[];
}

const MAX_DISCLOSURE_DEPTH = 5;
const MAX_DISCLOSURE_KEYS = 64;
const MAX_DISCLOSURE_KEY_LENGTH = 80;
const MAX_DISCLOSURE_STRING_LENGTH = 512;
const MAX_DISCLOSURE_ARRAY_ITEMS = 20;

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

function validateWalletBridgeDisclosureValue(
  input: unknown,
  depth: number,
): WalletBridgeDisclosureValue | undefined {
  if (input === null) return null;
  if (typeof input === "string") {
    return input.length <= MAX_DISCLOSURE_STRING_LENGTH ? input : undefined;
  }
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (depth >= MAX_DISCLOSURE_DEPTH) return undefined;

  if (Array.isArray(input)) {
    if (input.length > MAX_DISCLOSURE_ARRAY_ITEMS) return undefined;
    const out: WalletBridgeDisclosureValue[] = [];
    for (const item of input) {
      const value = validateWalletBridgeDisclosureValue(item, depth + 1);
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  }

  if (!isPlainRecord(input)) return undefined;

  const entries = Object.entries(input);
  if (entries.length > MAX_DISCLOSURE_KEYS) return undefined;
  const out: WalletBridgeRouteDisclosure = {};
  for (const [key, rawValue] of entries) {
    if (key.length === 0 || key.length > MAX_DISCLOSURE_KEY_LENGTH) {
      return undefined;
    }
    const value = validateWalletBridgeDisclosureValue(rawValue, depth + 1);
    if (value === undefined) return undefined;
    out[key] = value;
  }
  return out;
}

export function validateWalletBridgeRouteDisclosure(
  input: unknown,
): WalletBridgeRouteDisclosure | null {
  const value = validateWalletBridgeDisclosureValue(input, 0);
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  return Object.keys(value).length > 0 ? value : null;
}

export function validateWalletBridgeRouteDisclosureList(
  input: unknown,
): WalletBridgeRouteDisclosure[] {
  if (Array.isArray(input)) {
    const out: WalletBridgeRouteDisclosure[] = [];
    for (const item of input.slice(0, MAX_DISCLOSURE_ARRAY_ITEMS)) {
      const row = validateWalletBridgeRouteDisclosure(item);
      if (row !== null) out.push(row);
    }
    return out;
  }

  const one = validateWalletBridgeRouteDisclosure(input);
  return one === null ? [] : [one];
}

export function collectWalletBridgeRouteDisclosures(
  input: unknown,
): WalletBridgeRouteDisclosure[] {
  if (!isPlainRecord(input)) return [];

  const out: WalletBridgeRouteDisclosure[] = [];
  const single = validateWalletBridgeRouteDisclosure(input.bridgeRouteDisclosure);
  if (single !== null) out.push(single);
  out.push(
    ...validateWalletBridgeRouteDisclosureList(input.bridgeRouteDisclosures),
  );
  return out;
}

function validateWalletTokenBalanceMrcIdentity(
  input: unknown,
): WalletTokenBalanceMrcIdentity | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const r = input as Record<string, unknown>;
  if (typeof r.standard !== "string" || r.standard.length === 0) return null;
  if (typeof r.assetId !== "string" || r.assetId.length === 0) return null;
  if (
    r.tokenId !== undefined &&
    r.tokenId !== null &&
    typeof r.tokenId !== "string"
  ) {
    return null;
  }
  return {
    standard: r.standard,
    assetId: r.assetId,
    ...(typeof r.tokenId === "string" ? { tokenId: r.tokenId } : {}),
  };
}

export function validateWalletTokenBalance(
  input: unknown,
): WalletTokenBalance | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.tokenId !== "string") return null;
  if (typeof r.balance !== "string") return null;
  if (!isFiniteNum(r.updatedAtBlock)) return null;

  const out: WalletTokenBalance = {
    tokenId: r.tokenId,
    balance: r.balance,
    updatedAtBlock: r.updatedAtBlock,
  };

  if (r.mrc !== undefined && r.mrc !== null) {
    const mrc = validateWalletTokenBalanceMrcIdentity(r.mrc);
    if (mrc === null) return null;
    out.mrc = mrc;
  }

  const bridgeRouteDisclosure = validateWalletBridgeRouteDisclosure(
    r.bridgeRouteDisclosure,
  );
  if (bridgeRouteDisclosure !== null) {
    out.bridgeRouteDisclosure = bridgeRouteDisclosure;
  }

  const bridgeRouteDisclosures = validateWalletBridgeRouteDisclosureList(
    r.bridgeRouteDisclosures,
  );
  if (bridgeRouteDisclosures.length > 0) {
    out.bridgeRouteDisclosures = bridgeRouteDisclosures;
  }

  return out;
}

export function validateWalletTokenBalanceList(
  input: unknown[],
): WalletTokenBalance[] {
  const out: WalletTokenBalance[] = [];
  for (const raw of input) {
    const row = validateWalletTokenBalance(raw);
    if (row !== null) out.push(row);
  }
  return out;
}
