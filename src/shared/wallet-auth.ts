import { keccak_256 } from "@noble/hashes/sha3.js";
import { typedBech32ToAddress } from "@monolythium/core-sdk";

/**
 * Wallet authentication v1 wallet-boundary adapter.
 *
 * The generic SDK owns the cross-application challenge/proof contract. This
 * wallet-side layer additionally validates the dApp request before inserting
 * the privileged active signer. Keep the field order, signing prefix, and
 * validation limits byte-for-byte aligned with the published SDK.
 */

export const WALLET_AUTH_CHALLENGE_VERSION = "1" as const;
export const WALLET_AUTH_ALGORITHM = "ml-dsa-65" as const;
export const WALLET_AUTH_SIGNING_PREFIX = "monolythium.wallet-auth.v1\0" as const;
export const WALLET_AUTH_MAX_TTL_MS = 180_000;
export const WALLET_AUTH_CLOCK_SKEW_MS = 30_000;

const REQUEST_FIELDS = [
  "version",
  "domain",
  "origin",
  "uri",
  "chainId",
  "genesisHash",
  "nonce",
  "issuedAt",
  "expirationTime",
  "scopes",
] as const;
const CHALLENGE_FIELDS = [
  "version",
  "domain",
  "origin",
  "uri",
  "address",
  "chainId",
  "genesisHash",
  "nonce",
  "issuedAt",
  "expirationTime",
  "scopes",
] as const;

const GENESIS_HASH_RE = /^0x[0-9a-f]{64}$/;
const CHAIN_ID_RE = /^(0|[1-9][0-9]*)$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_RE = /^[A-Za-z0-9._:/-]+$/;
const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_FIELD_NAME_LENGTH = 32;
const MAX_VERSION_LENGTH = 8;
const MAX_DOMAIN_LENGTH = 512;
const MAX_ORIGIN_LENGTH = 528;
const MAX_URI_LENGTH = 529;
const MAX_CHAIN_ID_LENGTH = 78;
const MAX_GENESIS_HASH_LENGTH = 66;
const MAX_NONCE_LENGTH = 43;
const MAX_CANONICAL_TIME_LENGTH = 24;
const MAX_SCOPE_LENGTH = 128;
const MAX_TYPED_ADDRESS_LENGTH = 128;

export interface WalletAuthRequestV1 {
  version: "1";
  domain: string;
  origin: string;
  uri: string;
  chainId: string;
  genesisHash: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  scopes: string[];
}

export interface WalletAuthChallengeV1 extends WalletAuthRequestV1 {
  address: string;
}

export interface WalletAuthProofV1 {
  challenge: WalletAuthChallengeV1;
  algorithm: "ml-dsa-65";
  publicKey: string;
  signature: string;
}

export interface WalletAuthRequestContext {
  /** The canonical origin stamped by the isolated-world bridge. */
  origin: string;
  /** The active wallet chain id as an unsigned decimal string. */
  chainId: string;
  /** The active wallet's pinned chain identity. */
  genesisHash: string;
  nowMs?: number;
}

export class WalletAuthRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletAuthRequestError";
  }
}

function fail(message: string): never {
  throw new WalletAuthRequestError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactFields(value: Record<string, unknown>): void {
  const expected = new Set<string>(REQUEST_FIELDS);
  let actualCount = 0;
  // Do not call Object.keys/Reflect.ownKeys here: both materialize every
  // attacker-controlled key before a count can be enforced. Stop the own-key
  // walk as soon as the small diagnostic allowance is exhausted.
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    actualCount += 1;
    if (actualCount > REQUEST_FIELDS.length + 4) {
      fail("wallet authentication request contains too many fields");
    }
    if (key.length > MAX_FIELD_NAME_LENGTH) {
      fail("wallet authentication request contains an invalid field name");
    }
    if (!expected.has(key)) fail(`wallet authentication field ${key} is not allowed`);
  }
  for (const key of REQUEST_FIELDS) {
    if (!Object.hasOwn(value, key)) fail(`wallet authentication field ${key} is required`);
  }
}

function requireExactChallengeFields(value: Record<string, unknown>): void {
  const expected = new Set<string>(CHALLENGE_FIELDS);
  let actualCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    actualCount += 1;
    if (
      actualCount > CHALLENGE_FIELDS.length ||
      key.length > MAX_FIELD_NAME_LENGTH ||
      !expected.has(key)
    ) {
      fail("wallet authentication challenge contains missing or unknown fields");
    }
  }
  if (
    actualCount !== CHALLENGE_FIELDS.length ||
    CHALLENGE_FIELDS.some((key) => !Object.hasOwn(value, key))
  ) {
    fail("wallet authentication challenge contains missing or unknown fields");
  }
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  // Length is deliberately checked before every regex / URL / decoder scan.
  if (value.length > maxLength) fail(`${field} exceeds its maximum length`);
  if (!/^[\x20-\x7e]*$/.test(value)) fail(`${field} must contain printable ASCII only`);
  return value;
}

function canonicalOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("origin must be a canonical http(s) origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("origin must use http or https");
  }
  if (url.origin !== value) fail("origin must be canonical and contain no path");
  return url;
}

function parseCanonicalTime(value: unknown, field: string): { text: string; ms: number } {
  const text = requireString(value, field, MAX_CANONICAL_TIME_LENGTH);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    fail(`${field} must use canonical UTC ISO-8601 form`);
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || ms < 0 || new Date(ms).toISOString() !== text) {
    fail(`${field} is not a valid canonical UTC instant`);
  }
  return { text, ms };
}

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    fail("scopes must contain between 1 and 16 entries");
  }
  const scopes: string[] = [];
  for (const raw of value) {
    const scope = requireString(raw, "scope", MAX_SCOPE_LENGTH);
    if (!SCOPE_RE.test(scope)) {
      fail(`scope ${scope} is malformed`);
    }
    const previous = scopes.at(-1);
    if (previous !== undefined && previous >= scope) {
      fail("scopes must be sorted and unique");
    }
    scopes.push(scope);
  }
  return scopes;
}

function assertNonce(value: string): void {
  if (!NONCE_RE.test(value)) {
    fail("nonce must be unpadded base64url encoding exactly 32 bytes");
  }
  try {
    const decoded = base64UrlToBytes(value);
    if (decoded.length !== 32 || bytesToBase64Url(decoded) !== value) {
      fail("nonce must be canonical base64url encoding exactly 32 bytes");
    }
  } catch (error) {
    if (error instanceof WalletAuthRequestError) throw error;
    fail("nonce must be canonical base64url encoding exactly 32 bytes");
  }
}

/** Strictly validate and bind a dApp request to bridge and wallet state. */
export function parseWalletAuthRequestV1(
  input: unknown,
  context: WalletAuthRequestContext,
): WalletAuthRequestV1 {
  if (!isRecord(input)) fail("monolythium_authenticate params must be an object");
  requireExactFields(input);

  const actualUrl = canonicalOrigin(context.origin);
  const expectedOrigin = actualUrl.origin;
  const expectedDomain = actualUrl.host;
  const expectedUri = `${expectedOrigin}/`;

  const version = requireString(input.version, "version", MAX_VERSION_LENGTH);
  if (version !== WALLET_AUTH_CHALLENGE_VERSION) fail("unsupported wallet authentication version");

  const origin = requireString(input.origin, "origin", MAX_ORIGIN_LENGTH);
  const domain = requireString(input.domain, "domain", MAX_DOMAIN_LENGTH);
  const uri = requireString(input.uri, "uri", MAX_URI_LENGTH);
  if (origin !== expectedOrigin) fail("challenge origin does not match the requesting page");
  if (domain !== expectedDomain) fail("challenge domain does not match the requesting page");
  if (uri !== expectedUri) fail("challenge URI does not match the requesting page");

  const chainId = requireString(input.chainId, "chainId", MAX_CHAIN_ID_LENGTH);
  if (
    !CHAIN_ID_RE.test(chainId) ||
    (chainId.length === MAX_CHAIN_ID_LENGTH && chainId > MAX_UINT256_DECIMAL)
  ) {
    fail("chainId must be a canonical unsigned uint256 decimal string");
  }
  if (chainId !== context.chainId) fail("challenge chainId does not match the active wallet network");

  const genesisHash = requireString(
    input.genesisHash,
    "genesisHash",
    MAX_GENESIS_HASH_LENGTH,
  );
  if (!GENESIS_HASH_RE.test(genesisHash)) fail("genesisHash must be lowercase 0x-prefixed 32-byte hex");
  if (genesisHash !== context.genesisHash) {
    fail("challenge genesisHash does not match the active wallet network");
  }

  const nonce = requireString(input.nonce, "nonce", MAX_NONCE_LENGTH);
  assertNonce(nonce);

  const issued = parseCanonicalTime(input.issuedAt, "issuedAt");
  const expiration = parseCanonicalTime(input.expirationTime, "expirationTime");
  const now = context.nowMs ?? Date.now();
  const ttl = expiration.ms - issued.ms;
  if (ttl <= 0 || ttl > WALLET_AUTH_MAX_TTL_MS) {
    fail("wallet authentication lifetime must be greater than 0 and at most 180 seconds");
  }
  if (issued.ms > now + WALLET_AUTH_CLOCK_SKEW_MS) {
    fail("wallet authentication challenge was issued too far in the future");
  }
  if (expiration.ms <= now) fail("wallet authentication challenge has expired");

  const scopes = parseScopes(input.scopes);

  return {
    version: WALLET_AUTH_CHALLENGE_VERSION,
    domain,
    origin,
    uri,
    chainId,
    genesisHash,
    nonce,
    issuedAt: issued.text,
    expirationTime: expiration.text,
    scopes,
  };
}

/** Insert the wallet-controlled signer in the v1 canonical field order. */
export function buildWalletAuthChallengeV1(
  request: WalletAuthRequestV1,
  address: string,
): WalletAuthChallengeV1 {
  const boundedAddress = requireString(
    address,
    "address",
    MAX_TYPED_ADDRESS_LENGTH,
  );
  try {
    if (boundedAddress !== boundedAddress.toLowerCase()) throw new Error("non-canonical case");
    typedBech32ToAddress(boundedAddress, "user");
  } catch {
    fail("wallet authentication requires a canonical typed mono1 address");
  }
  return {
    version: WALLET_AUTH_CHALLENGE_VERSION,
    domain: request.domain,
    origin: request.origin,
    uri: request.uri,
    address: boundedAddress,
    chainId: request.chainId,
    genesisHash: request.genesisHash,
    nonce: request.nonce,
    issuedAt: request.issuedAt,
    expirationTime: request.expirationTime,
    scopes: [...request.scopes],
  };
}

/** Strict clone boundary mirroring the generic SDK's public surface. */
export function canonicalizeWalletAuthChallengeV1(
  value: unknown,
): WalletAuthChallengeV1 {
  if (!isRecord(value)) fail("wallet authentication challenge must be an object");
  requireExactChallengeFields(value);
  const request = parseWalletAuthRequestV1(
    {
      version: value.version,
      domain: value.domain,
      origin: value.origin,
      uri: value.uri,
      chainId: value.chainId,
      genesisHash: value.genesisHash,
      nonce: value.nonce,
      issuedAt: value.issuedAt,
      expirationTime: value.expirationTime,
      scopes: value.scopes,
    },
    {
      origin: requireString(value.origin, "origin", MAX_ORIGIN_LENGTH),
      chainId: requireString(value.chainId, "chainId", MAX_CHAIN_ID_LENGTH),
      genesisHash: requireString(
        value.genesisHash,
        "genesisHash",
        MAX_GENESIS_HASH_LENGTH,
      ),
      // Canonicalization checks intrinsic framing/lifetime but not wall-clock
      // freshness. Relying parties perform freshness at verification time.
      nowMs: Date.parse(
        requireString(
          value.issuedAt,
          "issuedAt",
          MAX_CANONICAL_TIME_LENGTH,
        ),
      ),
    },
  );
  return buildWalletAuthChallengeV1(
    request,
    requireString(value.address, "address", MAX_TYPED_ADDRESS_LENGTH),
  );
}

/** Canonical no-whitespace JSON. Property insertion order is protocol. */
export function canonicalWalletAuthChallengeJsonV1(
  value: unknown,
): string {
  const challenge = canonicalizeWalletAuthChallengeV1(value);
  return JSON.stringify({
    version: challenge.version,
    domain: challenge.domain,
    origin: challenge.origin,
    uri: challenge.uri,
    address: challenge.address,
    chainId: challenge.chainId,
    genesisHash: challenge.genesisHash,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expirationTime: challenge.expirationTime,
    scopes: challenge.scopes,
  });
}

export function encodeWalletAuthChallengeV1(
  challenge: WalletAuthChallengeV1,
): Uint8Array {
  return new TextEncoder().encode(canonicalWalletAuthChallengeJsonV1(challenge));
}

export function walletAuthChallengeSigningPreimageV1(
  challenge: WalletAuthChallengeV1,
): Uint8Array {
  const prefix = new TextEncoder().encode(WALLET_AUTH_SIGNING_PREFIX);
  const encoded = encodeWalletAuthChallengeV1(challenge);
  const out = new Uint8Array(prefix.length + encoded.length);
  out.set(prefix, 0);
  out.set(encoded, prefix.length);
  return out;
}

export function walletAuthChallengeDigestV1(
  challenge: WalletAuthChallengeV1,
): Uint8Array {
  return keccak_256(walletAuthChallengeSigningPreimageV1(challenge));
}

export function bytesToLowerHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function base64UrlToBytes(value: string): Uint8Array {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
