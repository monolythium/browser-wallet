// Monolythium Wallet — legacy v2 encrypted keystore.
//
// This module is the pre-PQM secp256k1/EIP-1193 compatibility vault. Current
// ML-DSA-65/PQM-1 vaults live in keystore-mldsa.ts and derive Mono address
// payloads through the SDK's ADR-0038 BLAKE3 rule.
//
// Vault layout (stored under chrome.storage.local["mono.vault"]):
//
//   {
//     version: 2,                          // schema version
//     kdf: "argon2id",
//     kdfParams: {
//       m: 65536,                          // memory cost, KiB (= 64 MiB)
//       t: 3,                              // time cost (iterations)
//       p: 1,                              // parallelism
//       salt: "<base64 16B>",
//     },
//     aead: "xchacha20-poly1305",
//     nonce: "<base64 24B>",               // XChaCha20 nonce (random, AEAD-safe)
//     ciphertext: "<base64 priv||tag>",    // XChaCha20-Poly1305 ciphertext + auth tag
//     addr: "0x...",                       // legacy EIP-1193 address cache
//                                          // shown only through typed display helpers
//   }
//
// Only the encrypted ciphertext + a bit of envelope metadata ever touches disk.
// The plaintext private key lives only in the service worker's memory while the
// wallet is unlocked, and is zeroed when the user locks or the worker hibernates.
//
// v1 vaults (PBKDF2+AES-GCM, schema `{ v: 1, kdf: "pbkdf2-sha256", ... }`) are
// REJECTED on unlock. Per the v1→v2 ethos there is no silent re-encryption; the
// user is told the vault format upgraded and asked to re-import their seed.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { getPublicKey, signAsync } from "@noble/secp256k1";
import { buildAndSignLegacyTx, type LegacyTxRequest } from "./tx.js";

const VAULT_KEY = "mono.vault";

// Argon2id cost parameters. RFC 9106 §4 recommends `t >= 1` and `m >= 64 MiB`
// for "second-recommended option" interactive use. 64 MiB / t=3 / p=1 is the
// browser-wallet default that MetaMask and Phantom converged on after the
// 2023–24 cohort of round-trip benchmarks (~600–1200 ms on a 2020-era laptop;
// fast enough that unlock UX doesn't suffer, slow enough that an offline
// brute-forcer pays the full memory tax per guess). If a future hardware
// budget says otherwise, document the reason here and bump `kdfParams.m`.
const ARGON2_M_KIB = 64 * 1024; // 64 MiB
const ARGON2_T = 3;
const ARGON2_P = 1;
const ARGON2_DKLEN = 32; // XChaCha20 key length

const SALT_LEN = 16;
const XCHACHA_NONCE_LEN = 24;

const SCHEMA_VERSION = 2;
const KDF_ID = "argon2id" as const;
const AEAD_ID = "xchacha20-poly1305" as const;

// Standard Ethereum BIP-44 path: m/44'/60'/0'/0/0
const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";

interface VaultEnvelopeV2 {
  version: 2;
  kdf: typeof KDF_ID;
  kdfParams: {
    m: number;
    t: number;
    p: number;
    salt: string;
  };
  aead: typeof AEAD_ID;
  nonce: string;
  ciphertext: string;
  addr: string;
}

// Minimal v1 detector — we read just enough to recognise the legacy shape and
// throw a clean message. We never decrypt v1 ciphertext.
interface VaultEnvelopeV1Heuristic {
  v?: 1;
  kdf?: "pbkdf2-sha256";
}

/** Error thrown when a v1 (PBKDF2+AES-GCM) envelope is found. */
export class LegacyVaultError extends Error {
  constructor() {
    super(
      "vault format upgraded — re-import your seed (v1 PBKDF2+AES-GCM vault detected; v2 uses argon2id+xchacha20-poly1305)",
    );
    this.name = "LegacyVaultError";
  }
}

interface UnlockedState {
  privKey: Uint8Array;
  address: string;
}

let unlocked: UnlockedState | null = null;

// ---- base64 helpers (no Buffer in service workers) ----

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

// ---- chrome.storage helpers ----

/** Read the raw stored vault entry. Used both to load v2 envelopes and to
 * detect v1 (legacy PBKDF2) envelopes during unlock. */
async function loadRawVault(): Promise<unknown | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([VAULT_KEY], (res) => {
      resolve(res?.[VAULT_KEY] ?? null);
    });
  });
}

function isV1Envelope(raw: unknown): raw is VaultEnvelopeV1Heuristic {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  // v1 used numeric `v` (and not a `version` key) plus the PBKDF2 kdf id.
  return obj["v"] === 1 || obj["kdf"] === "pbkdf2-sha256";
}

function isV2Envelope(raw: unknown): raw is VaultEnvelopeV2 {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== SCHEMA_VERSION) return false;
  if (obj["kdf"] !== KDF_ID) return false;
  if (obj["aead"] !== AEAD_ID) return false;
  const params = obj["kdfParams"] as Record<string, unknown> | undefined;
  if (!params || typeof params !== "object") return false;
  if (typeof params["m"] !== "number") return false;
  if (typeof params["t"] !== "number") return false;
  if (typeof params["p"] !== "number") return false;
  if (typeof params["salt"] !== "string") return false;
  if (typeof obj["nonce"] !== "string") return false;
  if (typeof obj["ciphertext"] !== "string") return false;
  if (typeof obj["addr"] !== "string") return false;
  return true;
}

async function loadVault(): Promise<VaultEnvelopeV2 | null> {
  const raw = await loadRawVault();
  if (raw === null) return null;
  if (isV2Envelope(raw)) return raw;
  if (isV1Envelope(raw)) throw new LegacyVaultError();
  // Anything else is a corrupt or future-version envelope; surface a clear
  // error rather than silently treating it as "no vault".
  throw new Error("vault envelope is unrecognised — refusing to read");
}

async function saveVault(envelope: VaultEnvelopeV2): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [VAULT_KEY]: envelope }, () => resolve());
  });
}

// ---- key derivation ----

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const passBytes = new TextEncoder().encode(password);
  // Argon2id is async on purpose: at m=64 MiB / t=3 the synchronous variant
  // would lock the service worker for ~1 s on a typical laptop. The async
  // helper yields to the event loop on a configurable tick.
  return argon2idAsync(passBytes, salt, {
    m: ARGON2_M_KIB,
    t: ARGON2_T,
    p: ARGON2_P,
    dkLen: ARGON2_DKLEN,
  });
}

function privKeyToAddress(priv: Uint8Array): string {
  // Uncompressed public key, drop the 0x04 prefix to get the 64-byte X||Y.
  const pub = getPublicKey(priv, false);
  const xy = pub.slice(1);
  const hash = keccak_256(xy);
  // Legacy v2/EIP-1193 address cache. Not used for Mono ADR-0038 public
  // address derivation; current PQM vaults derive in keystore-mldsa.ts.
  const addrBytes = hash.slice(-20);
  return "0x" + bytesToHex(addrBytes);
}

async function deriveSecp256k1FromMnemonic(mnemonic: string): Promise<Uint8Array> {
  const seed = await mnemonicToSeed(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(ETH_DERIVATION_PATH);
  if (!node.privateKey) {
    throw new Error("BIP-32 derivation failed to produce a private key");
  }
  return node.privateKey;
}

// ---- public API ----

/**
 * Return `true` when a v2 vault is present.
 *
 * Treats v1 envelopes (and corrupt blobs) as "no vault" so the popup's
 * onboarding flow can run and the user can re-import. The v1-detection
 * branch deliberately swallows {@link LegacyVaultError}; the unlock path
 * surfaces it instead — `hasVault()` is queried while the popup paints
 * before the user has a password to type.
 */
export async function hasVault(): Promise<boolean> {
  try {
    const v = await loadVault();
    return v !== null;
  } catch (e) {
    if (e instanceof LegacyVaultError) return false;
    throw e;
  }
}

/**
 * Cached on-disk address. Returns `null` when no v2 vault exists — including
 * when a v1 envelope is present (the user must re-import their seed).
 */
export async function getStoredAddress(): Promise<string | null> {
  try {
    const v = await loadVault();
    return v?.addr ?? null;
  } catch (e) {
    if (e instanceof LegacyVaultError) return null;
    throw e;
  }
}

/** Whether the stored envelope is a legacy v1 (PBKDF2+AES-GCM) blob. */
export async function hasLegacyVault(): Promise<boolean> {
  const raw = await loadRawVault();
  return isV1Envelope(raw);
}

export function isUnlocked(): boolean {
  return unlocked !== null;
}

export function getUnlockedAddress(): string | null {
  return unlocked?.address ?? null;
}

/**
 * Lock the wallet — zero the in-memory key.
 */
export function lock(): void {
  if (unlocked) {
    unlocked.privKey.fill(0);
    unlocked = null;
  }
}

/**
 * Create a new vault from a freshly generated 12-word mnemonic. Returns the
 * mnemonic so onboarding can show it to the user; nothing else ever leaves
 * the keystore.
 */
export async function createVaultFromNewMnemonic(password: string): Promise<{
  mnemonic: string;
  address: string;
}> {
  if (await hasVault()) {
    throw new Error("vault already exists; cannot overwrite");
  }
  const mnemonic = generateMnemonic(englishWordlist, 128);
  const address = await commitNewVault(password, mnemonic);
  return { mnemonic, address };
}

/**
 * Create a vault from a user-supplied mnemonic (import flow).
 */
export async function createVaultFromMnemonic(
  password: string,
  mnemonic: string,
): Promise<{ address: string }> {
  if (await hasVault()) {
    throw new Error("vault already exists; cannot overwrite");
  }
  if (!validateMnemonic(mnemonic, englishWordlist)) {
    throw new Error("invalid mnemonic");
  }
  const address = await commitNewVault(password, mnemonic);
  return { address };
}

async function commitNewVault(password: string, mnemonic: string): Promise<string> {
  const priv = await deriveSecp256k1FromMnemonic(mnemonic);
  const address = privKeyToAddress(priv);

  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(XCHACHA_NONCE_LEN);
  const dek = await deriveKey(password, salt);
  const cipher = xchacha20poly1305(dek, nonce);
  const ct = cipher.encrypt(priv);

  // Wipe the freshly derived DEK (priv stays in `unlocked`).
  dek.fill(0);

  const envelope: VaultEnvelopeV2 = {
    version: SCHEMA_VERSION,
    kdf: KDF_ID,
    kdfParams: {
      m: ARGON2_M_KIB,
      t: ARGON2_T,
      p: ARGON2_P,
      salt: bytesToBase64(salt),
    },
    aead: AEAD_ID,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ct),
    addr: address,
  };
  await saveVault(envelope);

  unlocked = { privKey: priv, address };
  return address;
}

/**
 * Decrypt the vault and load the private key into memory.
 *
 * Throws {@link LegacyVaultError} when a v1 envelope is detected; throws a
 * generic `"wrong password"` `Error` on AEAD failure. The popup surfaces both
 * messages directly to the user (the unlock IPC routes `e.message`).
 */
export async function unlock(password: string): Promise<{ address: string }> {
  const v = await loadVault();
  if (!v) throw new Error("no vault — run onboarding first");

  const salt = base64ToBytes(v.kdfParams.salt);
  const nonce = base64ToBytes(v.nonce);
  const ct = base64ToBytes(v.ciphertext);
  // Derive with the salt + cost params actually stored in the envelope so
  // future cost-bumps don't break old vaults (we re-encrypt on next change,
  // not silently at unlock — see file header).
  const passBytes = new TextEncoder().encode(password);
  const dek = await argon2idAsync(passBytes, salt, {
    m: v.kdfParams.m,
    t: v.kdfParams.t,
    p: v.kdfParams.p,
    dkLen: ARGON2_DKLEN,
  });
  let priv: Uint8Array;
  try {
    const cipher = xchacha20poly1305(dek, nonce);
    priv = cipher.decrypt(ct);
  } catch {
    throw new Error("wrong password");
  } finally {
    dek.fill(0);
  }
  if (priv.length !== 32) {
    priv.fill(0);
    throw new Error("vault payload is not a 32-byte private key");
  }
  const address = privKeyToAddress(priv);
  unlocked = { privKey: priv, address };
  return { address };
}

/**
 * Sign an arbitrary 32-byte hash with the unlocked private key.
 * Returns 65 bytes: r (32) | s (32) | v (1, recovery id 27 or 28).
 */
export async function signHash(hash32: Uint8Array): Promise<Uint8Array> {
  if (!unlocked) throw new Error("wallet is locked");
  if (hash32.length !== 32) throw new Error("signHash expects a 32-byte digest");

  // Noble's signAsync with format:"recovered" returns 65 bytes: r||s||recovery.
  const sig = await signAsync(hash32, unlocked.privKey, {
    prehash: false,
    format: "recovered",
  });
  const out = new Uint8Array(65);
  out.set(sig.subarray(0, 64), 0);
  // Recovery byte 0/1 -> EIP-191 v 27/28.
  out[64] = (sig[64]! & 1) + 27;
  return out;
}

/**
 * Apply Ethereum's `personal_sign` prefix and return a 65-byte signature.
 *   "\x19Ethereum Signed Message:\n" + len + message
 */
export async function personalSign(
  message: Uint8Array | string,
): Promise<Uint8Array> {
  const bytes =
    typeof message === "string"
      ? hexOrUtf8ToBytes(message)
      : message;
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${bytes.length}`,
  );
  const concat = new Uint8Array(prefix.length + bytes.length);
  concat.set(prefix, 0);
  concat.set(bytes, prefix.length);
  const digest = keccak_256(concat);
  return signHash(digest);
}

export function hexOrUtf8ToBytes(s: string): Uint8Array {
  if (s.startsWith("0x") || s.startsWith("0X")) {
    const rest = s.slice(2);
    const len = rest.length / 2;
    if (!Number.isInteger(len)) {
      // Fall back to utf8 if it's not even hex.
      return new TextEncoder().encode(s);
    }
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = parseInt(rest.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return new TextEncoder().encode(s);
}

/**
 * Build + sign a legacy EIP-155 transaction with the unlocked key.
 * The private key never leaves this module.
 */
export async function signLegacyTx(
  req: LegacyTxRequest,
): Promise<{ rawTx: string; txHash: string }> {
  if (!unlocked) throw new Error("wallet is locked");
  return buildAndSignLegacyTx(req, unlocked.privKey);
}

/**
 * Sign an EIP-712 typed-data v4 envelope with the unlocked key.
 * Returns the 65-byte signature in the standard `r||s||v` layout.
 */
export async function signTypedDataV4(envelope: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): Promise<Uint8Array> {
  if (!unlocked) throw new Error("wallet is locked");
  const digest = computeTypedDataDigest(envelope);
  return signHash(digest);
}

/**
 * Compute the 32-byte EIP-712 v4 digest for a typed-data envelope. Pure
 * function — exported so the popup can preview the digest before the user
 * commits and so tests can assert against fixtures.
 */
export function computeTypedDataDigest(envelope: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): Uint8Array {
  const domainHash = hashStruct("EIP712Domain", envelope.domain, {
    EIP712Domain: domainTypeFor(envelope.domain),
    ...envelope.types,
  });
  const messageHash = hashStruct(envelope.primaryType, envelope.message, {
    EIP712Domain: domainTypeFor(envelope.domain),
    ...envelope.types,
  });
  const out = new Uint8Array(2 + 32 + 32);
  out[0] = 0x19;
  out[1] = 0x01;
  out.set(domainHash, 2);
  out.set(messageHash, 34);
  return keccak_256(out);
}

// Build the `EIP712Domain` type list to match the populated keys in `domain`.
// EIP-712 spec: only the fields actually present in `domain` are encoded, so
// the type list shrinks accordingly.
function domainTypeFor(
  domain: Record<string, unknown>,
): Array<{ name: string; type: string }> {
  const candidates: Array<{ name: string; type: string }> = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ];
  return candidates.filter((c) => domain[c.name] !== undefined);
}

function hashStruct(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const enc = encodeData(primaryType, data, types);
  return keccak_256(enc);
}

function encodeType(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): string {
  const deps = collectTypeDeps(primaryType, types, new Set());
  deps.delete(primaryType);
  const sorted = [primaryType, ...Array.from(deps).sort()];
  return sorted
    .map((t) => {
      const fields = types[t] ?? [];
      return `${t}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    })
    .join("");
}

function collectTypeDeps(
  type: string,
  types: Record<string, Array<{ name: string; type: string }>>,
  found: Set<string>,
): Set<string> {
  const base = type.replace(/\[.*\]/g, "");
  if (found.has(base)) return found;
  if (!types[base]) return found;
  found.add(base);
  for (const f of types[base]) {
    collectTypeDeps(f.type, types, found);
  }
  return found;
}

function typeHash(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  return keccak_256(new TextEncoder().encode(encodeType(primaryType, types)));
}

function encodeData(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const fields = types[primaryType] ?? [];
  const head: Uint8Array[] = [typeHash(primaryType, types)];
  for (const f of fields) {
    head.push(encodeValue(f.type, data[f.name], types));
  }
  return concat(head);
}

function encodeValue(
  type: string,
  value: unknown,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  // Arrays
  const arr = type.match(/^(.+)\[(\d*)\]$/);
  if (arr) {
    const inner = arr[1]!;
    const items = Array.isArray(value) ? value : [];
    const parts = items.map((v) => encodeValue(inner, v, types));
    return keccak_256(concat(parts));
  }
  // Nested struct
  if (types[type]) {
    return hashStruct(type, (value as Record<string, unknown>) ?? {}, types);
  }
  if (type === "string") {
    const s = typeof value === "string" ? value : String(value ?? "");
    return keccak_256(new TextEncoder().encode(s));
  }
  if (type === "bytes") {
    const b = parseBytes(value);
    return keccak_256(b);
  }
  if (type === "bool") {
    return leftPad32(new Uint8Array([value ? 1 : 0]));
  }
  if (type === "address") {
    const s = typeof value === "string" ? value : "0x0";
    return leftPad32(parseHexBytes(s));
  }
  if (type.startsWith("bytes")) {
    // bytesN — right-pad to 32.
    const b = parseBytes(value);
    return rightPad32(b);
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return leftPad32(intToBytesBE(value));
  }
  // Fallback: treat as string
  const fallback = typeof value === "string" ? value : String(value ?? "");
  return keccak_256(new TextEncoder().encode(fallback));
}

function parseBytes(v: unknown): Uint8Array {
  if (typeof v === "string") return parseHexBytes(v);
  if (v instanceof Uint8Array) return v;
  return new Uint8Array(0);
}

function parseHexBytes(s: string): Uint8Array {
  const r = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (r.length === 0) return new Uint8Array(0);
  const padded = r.length % 2 === 1 ? "0" + r : r;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function intToBytesBE(v: unknown): Uint8Array {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number") n = BigInt(v);
  else if (typeof v === "string") {
    n = v.startsWith("0x") || v.startsWith("0X")
      ? BigInt(v)
      : BigInt(v.length === 0 ? "0" : v);
  } else n = 0n;
  if (n < 0n) {
    // Two's-complement for signed types; sufficient for typical EIP-712 payloads.
    n = (1n << 256n) + n;
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return parseHexBytes(hex);
}

function leftPad32(b: Uint8Array): Uint8Array {
  if (b.length >= 32) return b.slice(b.length - 32);
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

function rightPad32(b: Uint8Array): Uint8Array {
  if (b.length >= 32) return b.slice(0, 32);
  const out = new Uint8Array(32);
  out.set(b, 0);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const __internal = {
  privKeyToAddress,
  deriveSecp256k1FromMnemonic,
  computeTypedDataDigest,
  encodeType,
  // Test-only exports — let vitest bypass `chrome.storage.local` and assert on
  // the pure encryption envelope shape.
  isV1Envelope,
  isV2Envelope,
};
