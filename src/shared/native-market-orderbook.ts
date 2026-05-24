export type NativeMarketOrderBookJsonValue =
  | string
  | number
  | boolean
  | null
  | NativeMarketOrderBookJsonValue[]
  | { [key: string]: NativeMarketOrderBookJsonValue };

export type NativeMarketOrderBookRow = Record<string, NativeMarketOrderBookJsonValue>;

export interface NativeMarketOrderBookDelta {
  marketId: string;
  orderId: string;
  relatedOrderId?: string;
  eventName: string;
  action: "upsert" | "remove";
  side?: string;
  price?: string;
  quantity?: string;
  remaining?: string;
  status?: string;
  blockHeight: number;
  txIndex: number;
  logIndex: number;
}

export interface NativeMarketOrderBookReplayFilter {
  fromBlock: number;
  toBlock: number;
  limit?: number;
  cursor?: string;
  marketId?: string;
  eventName?: string;
  primaryId?: string;
  relatedId?: string;
  tokenId?: string;
  account?: string;
  counterparty?: string;
}

export interface NativeMarketOrderBookReplayResponse {
  schemaVersion: number;
  fromBlock: number;
  toBlock: number;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  filters: NativeMarketOrderBookRow;
  replay: true;
  streamTopic: "nativeMarketOrderBook";
  deltas: NativeMarketOrderBookDelta[];
  source: NativeMarketOrderBookRow | null;
}

const MAX_JSON_DEPTH = 5;
const MAX_JSON_KEYS = 96;
const MAX_JSON_KEY_LENGTH = 96;
const MAX_JSON_STRING_LENGTH = 2048;
const MAX_JSON_ARRAY_ITEMS = 250;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const proto = Object.getPrototypeOf(input);
  return proto === Object.prototype || proto === null;
}

function validateJsonValue(
  input: unknown,
  depth: number,
): NativeMarketOrderBookJsonValue | undefined {
  if (input === null) return null;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input === "string") {
    return input.length <= MAX_JSON_STRING_LENGTH ? input : undefined;
  }
  if (depth >= MAX_JSON_DEPTH) return undefined;
  if (Array.isArray(input)) {
    if (input.length > MAX_JSON_ARRAY_ITEMS) return undefined;
    const out: NativeMarketOrderBookJsonValue[] = [];
    for (const item of input) {
      const value = validateJsonValue(item, depth + 1);
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  }
  if (!isPlainRecord(input)) return undefined;
  return validateRow(input, depth + 1) ?? undefined;
}

function validateRow(input: unknown, depth = 0): NativeMarketOrderBookRow | null {
  if (!isPlainRecord(input)) return null;
  const entries = Object.entries(input);
  if (entries.length > MAX_JSON_KEYS) return null;
  const out: NativeMarketOrderBookRow = {};
  for (const [key, rawValue] of entries) {
    if (key.length === 0 || key.length > MAX_JSON_KEY_LENGTH) return null;
    const value = validateJsonValue(rawValue, depth + 1);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredSafeInteger(
  input: Record<string, unknown>,
  key: string,
): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function validateDelta(input: unknown): NativeMarketOrderBookDelta | null {
  if (!isPlainRecord(input)) return null;
  const marketId = requiredString(input, "marketId");
  const orderId = requiredString(input, "orderId");
  const eventName = requiredString(input, "eventName");
  const action = input.action;
  const blockHeight = requiredSafeInteger(input, "blockHeight");
  const txIndex = requiredSafeInteger(input, "txIndex");
  const logIndex = requiredSafeInteger(input, "logIndex");
  if (
    marketId === null ||
    orderId === null ||
    !HEX_32.test(marketId) ||
    !HEX_32.test(orderId) ||
    eventName === null ||
    action !== "upsert" && action !== "remove" ||
    blockHeight === null ||
    txIndex === null ||
    logIndex === null
  ) {
    return null;
  }
  const relatedOrderId = optionalString(input, "relatedOrderId");
  if (relatedOrderId !== undefined && !HEX_32.test(relatedOrderId)) return null;
  const delta: NativeMarketOrderBookDelta = {
    marketId,
    orderId,
    eventName,
    action,
    blockHeight,
    txIndex,
    logIndex,
  };
  if (relatedOrderId !== undefined) delta.relatedOrderId = relatedOrderId;
  const side = optionalString(input, "side");
  const price = optionalString(input, "price");
  const quantity = optionalString(input, "quantity");
  const remaining = optionalString(input, "remaining");
  const status = optionalString(input, "status");
  if (side !== undefined) delta.side = side;
  if (price !== undefined) delta.price = price;
  if (quantity !== undefined) delta.quantity = quantity;
  if (remaining !== undefined) delta.remaining = remaining;
  if (status !== undefined) delta.status = status;
  return delta;
}

export function validateNativeMarketOrderBookReplayResponse(
  input: unknown,
): NativeMarketOrderBookReplayResponse | null {
  if (!isPlainRecord(input)) return null;
  if (
    typeof input.schemaVersion !== "number" ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    input.replay !== true ||
    input.streamTopic !== "nativeMarketOrderBook"
  ) {
    return null;
  }
  const fromBlock = requiredSafeInteger(input, "fromBlock");
  const toBlock = requiredSafeInteger(input, "toBlock");
  const limit = requiredSafeInteger(input, "limit");
  if (fromBlock === null || toBlock === null || toBlock < fromBlock || limit === null) {
    return null;
  }
  const cursor = input.cursor === null || input.cursor === undefined
    ? null
    : typeof input.cursor === "string"
      ? input.cursor
      : undefined;
  const nextCursor = input.nextCursor === null || input.nextCursor === undefined
    ? null
    : typeof input.nextCursor === "string"
      ? input.nextCursor
      : undefined;
  if (cursor === undefined || nextCursor === undefined) return null;
  const filters = validateRow(input.filters ?? {});
  const source =
    input.source === undefined || input.source === null ? null : validateRow(input.source);
  if (filters === null || source === null && input.source !== undefined && input.source !== null) {
    return null;
  }
  if (!Array.isArray(input.deltas) || input.deltas.length > MAX_JSON_ARRAY_ITEMS) return null;
  const deltas: NativeMarketOrderBookDelta[] = [];
  for (const rawDelta of input.deltas) {
    const delta = validateDelta(rawDelta);
    if (delta === null) return null;
    deltas.push(delta);
  }
  return {
    schemaVersion: input.schemaVersion,
    fromBlock,
    toBlock,
    limit,
    cursor,
    nextCursor,
    filters,
    replay: true,
    streamTopic: "nativeMarketOrderBook",
    deltas,
    source,
  };
}

export function buildNativeMarketOrderBookReplayQuery(
  input: NativeMarketOrderBookReplayFilter,
): URLSearchParams | null {
  if (
    !Number.isSafeInteger(input.fromBlock) ||
    !Number.isSafeInteger(input.toBlock) ||
    input.fromBlock < 0 ||
    input.toBlock < input.fromBlock
  ) {
    return null;
  }
  const params = new URLSearchParams();
  params.set("fromBlock", String(input.fromBlock));
  params.set("toBlock", String(input.toBlock));
  for (const key of ["limit", "cursor", "marketId", "eventName", "primaryId", "relatedId", "tokenId", "account", "counterparty"] as const) {
    const value = input[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      params.set(key, String(value));
    } else if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  return params;
}
