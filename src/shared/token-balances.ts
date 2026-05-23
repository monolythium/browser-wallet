export interface WalletTokenBalanceMrcIdentity {
  standard: string;
  assetId: string;
  tokenId?: string;
}

export type WalletMrcHolderStandard = "mrc721" | "mrc1155" | "mrc4626";

export interface WalletMrcHolder {
  rank: number;
  address: string;
  balance: string;
  updatedAtBlock: number;
}

export interface WalletMrcHoldersResponse {
  schemaVersion: number;
  standard: WalletMrcHolderStandard;
  assetId: string;
  tokenId: string | null;
  limit: number;
  holders: WalletMrcHolder[];
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

export interface WalletBridgeRouteReadiness {
  routeSelectionReady: boolean;
  quoteReady: boolean;
  submitReady: boolean;
  blockedReasons: string[];
  warnings: string[];
}

export interface WalletBridgeRoutesCatalogue {
  bridgeRouteDisclosures: WalletBridgeRouteDisclosure[];
  readiness: WalletBridgeRouteReadiness | null;
}

export interface WalletTokenBalance {
  tokenId: string;
  balance: string;
  updatedAtBlock: number;
  mrc?: WalletTokenBalanceMrcIdentity;
  mrcHolders?: WalletMrcHoldersResponse;
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

function readBooleanAlias(
  input: Record<string, unknown>,
  aliases: readonly string[],
): boolean | null {
  for (const alias of aliases) {
    const value = input[alias];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function readStringListAlias(
  input: Record<string, unknown>,
  aliases: readonly string[],
): string[] {
  for (const alias of aliases) {
    const value = input[alias];
    if (!Array.isArray(value)) continue;
    const out: string[] = [];
    for (const item of value.slice(0, MAX_DISCLOSURE_ARRAY_ITEMS)) {
      if (typeof item !== "string") return [];
      if (item.length > MAX_DISCLOSURE_STRING_LENGTH) return [];
      out.push(item);
    }
    return out;
  }
  return [];
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

export function validateWalletBridgeRouteReadiness(
  input: unknown,
): WalletBridgeRouteReadiness | null {
  if (!isPlainRecord(input)) return null;
  const routeSelectionReady = readBooleanAlias(input, [
    "routeSelectionReady",
    "route_selection_ready",
  ]);
  const quoteReady = readBooleanAlias(input, ["quoteReady", "quote_ready"]);
  const submitReady = readBooleanAlias(input, ["submitReady", "submit_ready"]);
  const blockedReasons = readStringListAlias(input, [
    "blockedReasons",
    "blocked_reasons",
    "readinessBlockedReasons",
  ]);
  const warnings = readStringListAlias(input, [
    "warnings",
    "readinessWarnings",
  ]);

  if (
    routeSelectionReady === null &&
    quoteReady === null &&
    submitReady === null &&
    blockedReasons.length === 0 &&
    warnings.length === 0
  ) {
    return null;
  }

  return {
    routeSelectionReady: routeSelectionReady ?? false,
    quoteReady: quoteReady ?? false,
    submitReady: submitReady ?? false,
    blockedReasons,
    warnings,
  };
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

function normalizeWalletMrcHolderStandard(
  input: unknown,
): WalletMrcHolderStandard | null {
  if (input !== "mrc721" && input !== "mrc1155" && input !== "mrc4626") {
    return null;
  }
  return input;
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

function validateWalletMrcHolder(input: unknown): WalletMrcHolder | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (!isFiniteNum(r.rank) || !Number.isSafeInteger(r.rank) || r.rank < 1) {
    return null;
  }
  if (typeof r.address !== "string" || r.address.length === 0) return null;
  if (typeof r.balance !== "string") return null;
  const updatedAtBlock = validateBlockHeight(r.updatedAtBlock);
  if (updatedAtBlock === null) return null;
  return {
    rank: r.rank,
    address: r.address,
    balance: r.balance,
    updatedAtBlock,
  };
}

export function validateWalletMrcHoldersResponse(
  input: unknown,
): WalletMrcHoldersResponse | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (
    !isFiniteNum(r.schemaVersion) ||
    !Number.isSafeInteger(r.schemaVersion) ||
    r.schemaVersion < 1
  ) {
    return null;
  }
  const standard = normalizeWalletMrcHolderStandard(r.standard);
  if (standard === null) return null;
  if (typeof r.assetId !== "string" || r.assetId.length === 0) return null;
  let tokenId: string | null;
  if (standard === "mrc4626") {
    if (r.tokenId !== null && r.tokenId !== undefined) return null;
    tokenId = null;
  } else {
    if (typeof r.tokenId !== "string" || r.tokenId.length === 0) return null;
    tokenId = r.tokenId;
  }
  if (!isFiniteNum(r.limit) || !Number.isSafeInteger(r.limit) || r.limit < 1) {
    return null;
  }
  if (!Array.isArray(r.holders)) return null;

  const holders: WalletMrcHolder[] = [];
  for (const holder of r.holders.slice(0, Math.trunc(r.limit))) {
    const row = validateWalletMrcHolder(holder);
    if (row !== null) holders.push(row);
  }

  return {
    schemaVersion: r.schemaVersion,
    standard,
    assetId: r.assetId,
    tokenId,
    limit: Math.trunc(r.limit),
    holders,
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

  if (r.mrcHolders !== undefined && r.mrcHolders !== null) {
    const mrcHolders = validateWalletMrcHoldersResponse(r.mrcHolders);
    if (mrcHolders !== null) out.mrcHolders = mrcHolders;
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
