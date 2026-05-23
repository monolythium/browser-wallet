export type NativeMarketStateJsonValue =
  | string
  | number
  | boolean
  | null
  | NativeMarketStateJsonValue[]
  | { [key: string]: NativeMarketStateJsonValue };

export type NativeMarketStateRow = Record<string, NativeMarketStateJsonValue>;

export interface NativeMarketStateFilter {
  marketId?: string;
  orderId?: string;
  listingId?: string;
  collectionId?: string;
  includeSpotOrders?: boolean;
  limit?: number;
}

export interface NativeMarketStateResponse {
  schemaVersion: number;
  limit: number;
  filters: NativeMarketStateRow;
  spotMarkets: NativeMarketStateRow[];
  spotOrders: NativeMarketStateRow[];
  nftListings: NativeMarketStateRow[];
  collectionRoyalties: NativeMarketStateRow[];
  source: NativeMarketStateRow | null;
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
): NativeMarketStateJsonValue | undefined {
  if (input === null) return null;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input === "string") {
    return input.length <= MAX_JSON_STRING_LENGTH ? input : undefined;
  }
  if (depth >= MAX_JSON_DEPTH) return undefined;

  if (Array.isArray(input)) {
    if (input.length > MAX_JSON_ARRAY_ITEMS) return undefined;
    const out: NativeMarketStateJsonValue[] = [];
    for (const item of input) {
      const value = validateJsonValue(item, depth + 1);
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  }

  if (!isPlainRecord(input)) return undefined;
  return validateNativeMarketStateRow(input, depth + 1) ?? undefined;
}

function validateNativeMarketStateRow(
  input: unknown,
  depth = 0,
): NativeMarketStateRow | null {
  if (!isPlainRecord(input)) return null;
  const entries = Object.entries(input);
  if (entries.length > MAX_JSON_KEYS) return null;
  const out: NativeMarketStateRow = {};
  for (const [key, rawValue] of entries) {
    if (key.length === 0 || key.length > MAX_JSON_KEY_LENGTH) return null;
    const value = validateJsonValue(rawValue, depth + 1);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

function validateNativeMarketStateRows(input: unknown): NativeMarketStateRow[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_JSON_ARRAY_ITEMS) return null;
  const out: NativeMarketStateRow[] = [];
  for (const item of input) {
    const row = validateNativeMarketStateRow(item);
    if (row === null) return null;
    out.push(row);
  }
  return out;
}

function readRows(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): NativeMarketStateRow[] | null {
  const raw = record[camelKey] ?? record[snakeKey];
  return validateNativeMarketStateRows(raw);
}

export function validateNativeMarketStateResponse(
  input: unknown,
): NativeMarketStateResponse | null {
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

  const filters = validateNativeMarketStateRow(r.filters ?? {});
  const source =
    r.source === undefined || r.source === null
      ? null
      : validateNativeMarketStateRow(r.source);
  const spotMarkets = readRows(r, "spotMarkets", "spot_markets");
  const spotOrders = readRows(r, "spotOrders", "spot_orders");
  const nftListings = readRows(r, "nftListings", "nft_listings");
  const collectionRoyalties = readRows(
    r,
    "collectionRoyalties",
    "collection_royalties",
  );

  if (
    filters === null ||
    source === null && r.source !== undefined && r.source !== null ||
    spotMarkets === null ||
    spotOrders === null ||
    nftListings === null ||
    collectionRoyalties === null
  ) {
    return null;
  }

  return {
    schemaVersion: r.schemaVersion,
    limit: r.limit,
    filters,
    spotMarkets,
    spotOrders,
    nftListings,
    collectionRoyalties,
    source,
  };
}

export function buildNativeMarketStateRpcFilter(
  input: NativeMarketStateFilter = {},
): NativeMarketStateFilter {
  const out: NativeMarketStateFilter = {};
  if (typeof input.marketId === "string" && input.marketId.length > 0) {
    out.marketId = input.marketId;
  }
  if (typeof input.orderId === "string" && input.orderId.length > 0) {
    out.orderId = input.orderId;
  }
  if (typeof input.listingId === "string" && input.listingId.length > 0) {
    out.listingId = input.listingId;
  }
  if (typeof input.collectionId === "string" && input.collectionId.length > 0) {
    out.collectionId = input.collectionId;
  }
  if (typeof input.includeSpotOrders === "boolean") {
    out.includeSpotOrders = input.includeSpotOrders;
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
