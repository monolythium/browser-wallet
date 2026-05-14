// Phase 5 Commit 5 — ERC-721 / ERC-1155 read helpers + pinning storage.
//
// Ported from `browser-wallet-old/src/lib/nft-client.ts` (1191 LOC).
// KEPT: pinning storage, metadata fetch with IPFS gateway fallback +
// data: URI handling, 24h TTL metadata cache (read-through with
// expiration evict), ERC-721 read selectors + decoding, ERC-165
// supportsInterface for both ERC-721 and ERC-1155, ERC-1155 balanceOf
// / uri / safeTransferFrom + `{id}` placeholder substitution,
// transferFrom calldata encoding.
//
// STRIPPED: event-scan discovery (Sprintnet indexer cluster-wide
// disabled — v1 is add-by-address only); multi-chain caching, ENS,
// image proxying, bulk batch operations, tx-history correlation,
// secp256k1/Cosmos-era helpers, external request logging. The old
// evm{Nonce,GasPrice,EstimateGas,SendRawTx} helpers are replaced by
// the wallet's existing MonolythiumProvider / RpcClient flow on the
// SW side.
//
// ADAPTED: RPC routing goes through the SDK. Functions accept an
// `EthCaller` structurally compatible with `RpcClient` from
// @monolythium/core-sdk; production callers pass `new RpcClient(...)`,
// tests pass a stub. Hex + keccak come from `@noble/hashes` (already
// a wallet dep); no new npm packages.
//
// NFTs remain EVM-application-level — whitepaper v4.0 has zero
// ERC-721/1155 references. Permitted under §22.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// Pinning storage — user-pinned (collection address, tokenId) pairs.
// Renamed from CustomNftEntry → PinnedNft; identical wire/storage
// shape. The reference's `customNftContracts` storage key is preserved
// so any merge-back can read what we wrote.

export interface PinnedNft {
  /** v1 is Sprintnet-only; kept on the wire for future multi-chain. */
  chainId: number;
  /** Contract address. Comparisons lowercase-normalised. */
  address: string;
  /** Decimal string — bigint is not JSON-serialisable. */
  tokenId: string;
}

const STORAGE_KEY_PINNED = "customNftContracts";

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (res) => {
        resolve((res?.[key] as T | undefined) ?? undefined);
      });
    } catch {
      // Not in extension context (e.g. fresh isolate without the stub).
      resolve(undefined);
    }
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

export async function loadPinnedNfts(): Promise<PinnedNft[]> {
  const stored = await storageGet<PinnedNft[]>(STORAGE_KEY_PINNED);
  return Array.isArray(stored) ? stored : [];
}

async function savePinnedNfts(entries: PinnedNft[]): Promise<void> {
  await storageSet(STORAGE_KEY_PINNED, entries);
}

export async function pinNft(entry: PinnedNft): Promise<void> {
  const existing = await loadPinnedNfts();
  const dup = existing.some(
    (e) =>
      e.chainId === entry.chainId &&
      e.address.toLowerCase() === entry.address.toLowerCase() &&
      e.tokenId === entry.tokenId,
  );
  if (dup) return;
  await savePinnedNfts([...existing, entry]);
}

export async function unpinNft(
  chainId: number,
  address: string,
  tokenId: string,
): Promise<void> {
  const existing = await loadPinnedNfts();
  const lc = address.toLowerCase();
  const filtered = existing.filter(
    (e) =>
      !(
        e.chainId === chainId &&
        e.address.toLowerCase() === lc &&
        e.tokenId === tokenId
      ),
  );
  await savePinnedNfts(filtered);
}

// ---------------------------------------------------------------------------
// ABI encoding / decoding
// ---------------------------------------------------------------------------

/** keccak256 selector — leading 4 bytes (8 hex chars), no `0x` prefix. */
export function fnSelector(sig: string): string {
  const hash = keccak_256(new TextEncoder().encode(sig));
  return bytesToHex(hash).slice(0, 8);
}

function pad32(hex: string): string {
  return hex.padStart(64, "0");
}

function encodeAddress(addr: string): string {
  return pad32(addr.replace(/^0x/i, "").toLowerCase());
}

function encodeUint256(value: bigint): string {
  if (value < 0n) throw new Error("uint256 must be non-negative");
  return pad32(value.toString(16));
}

function decodeUint256(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!clean || clean === "0x") return 0n;
  return BigInt("0x" + clean);
}

function decodeBool(hex: string): boolean {
  return decodeUint256(hex) !== 0n;
}

/** Decode a Solidity `string` returned by an `eth_call`. The wire
 *  shape is `[offset(32) | length(32) | bytes(N) | padding]`. */
function decodeString(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length < 128) return "";
  const offset = Number(BigInt("0x" + clean.slice(0, 64))) * 2;
  const strLen = Number(BigInt("0x" + clean.slice(offset, offset + 64)));
  if (strLen === 0) return "";
  const strHex = clean.slice(offset + 64, offset + 64 + strLen * 2);
  const bytes = new Uint8Array(strLen);
  for (let i = 0; i < strLen; i++) {
    bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// EthCaller — structural subset of the SDK's RpcClient. The SDK's
// `ethCall(request: CallRequest, block?: BlockSelector)` is
// structurally assignable: CallRequest is all-optional, the second
// param drops cleanly. Production passes `new RpcClient(rpcUrl)`,
// tests pass a stub.

export interface EthCaller {
  ethCall(req: { to: string; data: string }): Promise<string>;
}

async function call(
  caller: EthCaller,
  to: string,
  data: string,
): Promise<string> {
  return caller.ethCall({ to, data });
}

// ---------------------------------------------------------------------------
// ERC-165 interface detection
// ---------------------------------------------------------------------------

const SUPPORTS_INTERFACE_SEL = fnSelector("supportsInterface(bytes4)");

/** ERC-165 interface IDs — 4 bytes each, no `0x` prefix. */
export const INTERFACE_ID_ERC721 = "80ac58cd";
export const INTERFACE_ID_ERC721_ENUMERABLE = "780e9d63";
export const INTERFACE_ID_ERC721_METADATA = "5b5e139f";
export const INTERFACE_ID_ERC1155 = "d9b67a26";

function encodeSupportsInterface(interfaceId: string): string {
  // bytes4 is right-padded to 32 bytes.
  return "0x" + SUPPORTS_INTERFACE_SEL + interfaceId + "0".repeat(56);
}

export async function supportsErc721(
  caller: EthCaller,
  contract: string,
): Promise<boolean> {
  try {
    const r = await call(
      caller,
      contract,
      encodeSupportsInterface(INTERFACE_ID_ERC721),
    );
    return decodeBool(r);
  } catch {
    return false;
  }
}

export async function supportsErc1155(
  caller: EthCaller,
  contract: string,
): Promise<boolean> {
  try {
    const r = await call(
      caller,
      contract,
      encodeSupportsInterface(INTERFACE_ID_ERC1155),
    );
    return decodeBool(r);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ERC-721 read selectors
// ---------------------------------------------------------------------------

/** ERC-721 `balanceOf(address)` → uint256. */
export async function erc721BalanceOf(
  caller: EthCaller,
  contract: string,
  owner: string,
): Promise<bigint> {
  const data = "0x" + fnSelector("balanceOf(address)") + encodeAddress(owner);
  return decodeUint256(await call(caller, contract, data));
}

/** ERC-721 `ownerOf(uint256)` → address. */
export async function erc721OwnerOf(
  caller: EthCaller,
  contract: string,
  tokenId: bigint,
): Promise<string> {
  const data = "0x" + fnSelector("ownerOf(uint256)") + encodeUint256(tokenId);
  const r = await call(caller, contract, data);
  const clean = r.startsWith("0x") ? r.slice(2) : r;
  return "0x" + clean.slice(24).toLowerCase();
}

/** ERC-721 `tokenURI(uint256)` → string. */
export async function erc721TokenURI(
  caller: EthCaller,
  contract: string,
  tokenId: bigint,
): Promise<string> {
  const data = "0x" + fnSelector("tokenURI(uint256)") + encodeUint256(tokenId);
  return decodeString(await call(caller, contract, data));
}

/** `name()` → string. Same selector for ERC-721 + ERC-1155 metadata
 *  extensions; many ERC-1155 contracts implement it as a courtesy. */
export async function contractName(
  caller: EthCaller,
  contract: string,
): Promise<string> {
  const data = "0x" + fnSelector("name()");
  return decodeString(await call(caller, contract, data));
}

/** `symbol()` → string. Same caveat as {@link contractName}. */
export async function contractSymbol(
  caller: EthCaller,
  contract: string,
): Promise<string> {
  const data = "0x" + fnSelector("symbol()");
  return decodeString(await call(caller, contract, data));
}

// ---------------------------------------------------------------------------
// ERC-1155 read selectors
// ---------------------------------------------------------------------------

/** ERC-1155 `balanceOf(address, uint256)` → uint256. ERC-1155 has no
 *  `ownerOf` — multiple addresses can hold non-zero balance for the
 *  same id. Treat balance > 0 as "owned". */
export async function erc1155BalanceOf(
  caller: EthCaller,
  contract: string,
  owner: string,
  tokenId: bigint,
): Promise<bigint> {
  const data =
    "0x" +
    fnSelector("balanceOf(address,uint256)") +
    encodeAddress(owner) +
    encodeUint256(tokenId);
  return decodeUint256(await call(caller, contract, data));
}

/** ERC-1155 `uri(uint256)` → string. The returned URI MAY contain a
 *  literal `{id}` placeholder; clients substitute it via
 *  {@link substituteErc1155IdPlaceholder} before fetching. */
export async function erc1155Uri(
  caller: EthCaller,
  contract: string,
  tokenId: bigint,
): Promise<string> {
  const data = "0x" + fnSelector("uri(uint256)") + encodeUint256(tokenId);
  return decodeString(await call(caller, contract, data));
}

/** Substitute the ERC-1155 `{id}` placeholder in a URI with the
 *  64-char lowercase-hex zero-padded token id (per EIP-1155 §metadata
 *  URI JSON Schema). Idempotent for URIs without the placeholder. */
export function substituteErc1155IdPlaceholder(
  uri: string,
  tokenId: bigint,
): string {
  if (!uri.includes("{id}")) return uri;
  const padded = pad32(tokenId.toString(16));
  return uri.replace(/\{id\}/g, padded);
}

// ---------------------------------------------------------------------------
// Transfer calldata encoding (consumed by the Send-NFT path)
// ---------------------------------------------------------------------------

/** ERC-721 `transferFrom(address,address,uint256)` → calldata. */
export function encodeErc721TransferFrom(
  from: string,
  to: string,
  tokenId: bigint,
): string {
  const sel = fnSelector("transferFrom(address,address,uint256)");
  return (
    "0x" +
    sel +
    encodeAddress(from) +
    encodeAddress(to) +
    encodeUint256(tokenId)
  );
}

/** ERC-1155 `safeTransferFrom(address,address,uint256,uint256,bytes)`
 *  → calldata. Always passes empty `data`. */
export function encodeErc1155SafeTransferFrom(
  from: string,
  to: string,
  tokenId: bigint,
  amount: bigint,
): string {
  const sel = fnSelector(
    "safeTransferFrom(address,address,uint256,uint256,bytes)",
  );
  // Static head: from(32) | to(32) | id(32) | amount(32) | dataOffset(32)
  // Dynamic tail: dataLength(32 = 0) → no data bytes.
  const dataOffset = encodeUint256(160n); // 5 * 32 bytes static head
  const dataLen = encodeUint256(0n);
  return (
    "0x" +
    sel +
    encodeAddress(from) +
    encodeAddress(to) +
    encodeUint256(tokenId) +
    encodeUint256(amount) +
    dataOffset +
    dataLen
  );
}

// ---------------------------------------------------------------------------
// Metadata fetch with IPFS gateway fallback + data: URI handling
// ---------------------------------------------------------------------------

export interface NftMetadata {
  name?: string;
  description?: string;
  image?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
}

/** Ordered list of IPFS gateways tried in sequence on each metadata
 *  fetch. The first one to return a 2xx with valid JSON wins. */
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
] as const;

/** Resolve `ipfs://CID/path` to the primary gateway URL, or pass
 *  through `https://` and safe `data:` URIs. Rejects every other
 *  scheme (`http://`, `javascript:`, `file:`, …) by returning null. */
export function resolveIpfsUri(uri: string): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();

  if (trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("data:")) {
    const mimeMatch = trimmed.match(/^data:([^;,]+)/);
    const mime = mimeMatch?.[1]?.toLowerCase() ?? "";
    // Reject SVG (script-injection), HTML, JS. Allow only raster MIMEs.
    const safeMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (safeMimes.includes(mime)) return trimmed;
    if (mime === "application/json") return trimmed;
    return null;
  }
  if (trimmed.startsWith("ipfs://")) {
    const cid = trimmed.slice(7);
    if (/[@?#\s]/.test(cid) || cid.includes("..")) return null;
    return `${IPFS_GATEWAYS[0]}${cid}`;
  }
  return null;
}

/** Build the full fallback list for an `ipfs://` URI; returns a
 *  single-element array for non-IPFS URIs that resolve cleanly,
 *  empty for unsupported / unsafe inputs. */
function resolveTokenUri(uri: string): string[] {
  if (!uri) return [];
  const trimmed = uri.trim();
  if (trimmed.startsWith("ipfs://")) {
    const cid = trimmed.slice(7);
    if (/[@?#\s]/.test(cid) || cid.includes("..")) return [];
    return IPFS_GATEWAYS.map((gw) => `${gw}${cid}`);
  }
  const single = resolveIpfsUri(trimmed);
  return single ? [single] : [];
}

/** Sanitise an image URI from NFT metadata. Same scheme rules as
 *  {@link resolveIpfsUri}; returns null for unsupported schemes. */
export function sanitizeImageUri(
  imageUri: string | undefined,
): string | null {
  if (!imageUri) return null;
  return resolveIpfsUri(imageUri);
}

/** Per-field sanitiser — caps name/description/image lengths and
 *  attribute count to keep cache entries bounded. */
function clampMetadata(data: NftMetadata): NftMetadata {
  const out: NftMetadata = { ...data };
  if (out.name) out.name = out.name.slice(0, 256);
  if (out.description) out.description = out.description.slice(0, 2048);
  if (out.image) out.image = out.image.slice(0, 2048);
  if (Array.isArray(out.attributes)) {
    out.attributes = out.attributes.slice(0, 64).map((a) => ({
      trait_type: String(a.trait_type ?? "").slice(0, 256),
      value: typeof a.value === "string" ? a.value.slice(0, 256) : a.value,
    }));
  }
  return out;
}

/** Fetch + parse NFT metadata. Handles `data:application/json`
 *  inline (no network), `ipfs://` with sequential gateway fallback,
 *  and `https://` direct. 10s per-request timeout via AbortSignal;
 *  rejects responses larger than 1 MiB to bound cache impact. */
export async function fetchNftMetadata(
  uri: string,
): Promise<NftMetadata | null> {
  const trimmed = uri?.trim() ?? "";
  if (!trimmed) return null;

  if (trimmed.startsWith("data:application/json")) {
    try {
      const commaIndex = trimmed.indexOf(",");
      if (commaIndex === -1) return null;
      const header = trimmed.slice(0, commaIndex);
      const payload = trimmed.slice(commaIndex + 1);
      const jsonStr = header.includes("base64")
        ? atob(payload)
        : decodeURIComponent(payload);
      return clampMetadata(JSON.parse(jsonStr) as NftMetadata);
    } catch {
      return null;
    }
  }

  const candidates = resolveTokenUri(trimmed);
  if (candidates.length === 0) return null;

  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 1_000_000) continue;
      return clampMetadata(JSON.parse(text) as NftMetadata);
    } catch {
      // Try next gateway.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 24h TTL metadata cache
// ---------------------------------------------------------------------------

const STORAGE_KEY_METADATA_CACHE = "nftMetadataCache";
export const METADATA_TTL_MS = 86_400_000; // 24 hours

interface NftMetadataCacheEntry {
  name?: string;
  description?: string;
  image?: string;
  cachedAt: number;
}

/** Keyed by `${contractAddressLowercase}:${tokenIdDecimal}`. */
type NftMetadataCacheStore = Record<string, NftMetadataCacheEntry>;

function metaKey(contract: string, tokenId: bigint): string {
  return `${contract.toLowerCase()}:${tokenId.toString()}`;
}

async function loadMetadataCacheStore(): Promise<NftMetadataCacheStore> {
  const stored = await storageGet<NftMetadataCacheStore>(
    STORAGE_KEY_METADATA_CACHE,
  );
  return stored && typeof stored === "object" ? stored : {};
}

async function saveMetadataCacheStore(
  store: NftMetadataCacheStore,
): Promise<void> {
  await storageSet(STORAGE_KEY_METADATA_CACHE, store);
}

/** Read a metadata cache entry. Returns null on miss OR on an entry
 *  whose `cachedAt` is older than {@link METADATA_TTL_MS}; expired
 *  entries are evicted from disk on the same call. `now` is injected
 *  for tests; production callers omit it. */
export async function getCachedNftMetadata(
  contract: string,
  tokenId: bigint,
  now: number = Date.now(),
): Promise<NftMetadata | null> {
  const store = await loadMetadataCacheStore();
  const key = metaKey(contract, tokenId);
  const hit = store[key];
  if (!hit) return null;
  if (now - hit.cachedAt >= METADATA_TTL_MS) {
    delete store[key];
    await saveMetadataCacheStore(store);
    return null;
  }
  const out: NftMetadata = {};
  if (hit.name !== undefined) out.name = hit.name;
  if (hit.description !== undefined) out.description = hit.description;
  if (hit.image !== undefined) out.image = hit.image;
  return out;
}

/** Persist a metadata entry. `now` is injected for tests. */
export async function putCachedNftMetadata(
  contract: string,
  tokenId: bigint,
  metadata: NftMetadata,
  now: number = Date.now(),
): Promise<void> {
  const store = await loadMetadataCacheStore();
  const entry: NftMetadataCacheEntry = { cachedAt: now };
  if (metadata.name !== undefined) entry.name = metadata.name;
  if (metadata.description !== undefined) entry.description = metadata.description;
  if (metadata.image !== undefined) entry.image = metadata.image;
  store[metaKey(contract, tokenId)] = entry;
  await saveMetadataCacheStore(store);
}

/** Read-through cache: hit returns immediately; miss fetches fresh
 *  via {@link fetchNftMetadata} and writes to the cache before
 *  returning. Pass-through for fetch failures (returns null without
 *  writing a tombstone). */
export async function fetchOrCacheNftMetadata(
  caller: EthCaller,
  contract: string,
  tokenId: bigint,
  options: { isErc1155?: boolean; now?: number } = {},
): Promise<NftMetadata | null> {
  const now = options.now ?? Date.now();
  const cached = await getCachedNftMetadata(contract, tokenId, now);
  if (cached) return cached;

  const rawUri = options.isErc1155
    ? await erc1155Uri(caller, contract, tokenId).catch(() => "")
    : await erc721TokenURI(caller, contract, tokenId).catch(() => "");
  if (!rawUri) return null;

  const uri = options.isErc1155
    ? substituteErc1155IdPlaceholder(rawUri, tokenId)
    : rawUri;
  const meta = await fetchNftMetadata(uri);
  if (meta) await putCachedNftMetadata(contract, tokenId, meta, now);
  return meta;
}

/** Walk the metadata cache and drop every entry older than the TTL.
 *  Returns the number of evictions performed. */
export async function evictExpiredMetadataCache(
  now: number = Date.now(),
): Promise<number> {
  const store = await loadMetadataCacheStore();
  let evicted = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (now - entry.cachedAt >= METADATA_TTL_MS) {
      delete store[key];
      evicted++;
    }
  }
  if (evicted > 0) await saveMetadataCacheStore(store);
  return evicted;
}
