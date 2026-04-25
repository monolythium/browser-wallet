// Monolythium Wallet — encrypted keystore.
//
// Vault layout (stored under chrome.storage.local["mono.vault"]):
//
//   {
//     v: 1,                       // schema version
//     kdf: "pbkdf2-sha256",
//     iter: 250000,               // PBKDF2 iterations
//     salt: "<base64 16B>",       // PBKDF2 salt
//     nonce: "<base64 12B>",      // AES-GCM nonce
//     ct: "<base64 ciphertext>",  // AES-GCM(plaintext = 32-byte secp256k1 priv key)
//     addr: "0x...",              // derived 20-byte address (cached so popup can show it locked)
//   }
//
// Only the encrypted ciphertext + a bit of envelope metadata ever touches disk.
// The plaintext private key lives only in the service worker's memory while the
// wallet is unlocked, and is zeroed when the user locks or the worker hibernates.

import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { getPublicKey, signAsync } from "@noble/secp256k1";
import { buildAndSignLegacyTx, type LegacyTxRequest } from "./tx.js";

const VAULT_KEY = "mono.vault";
const PBKDF2_ITERATIONS = 250_000;
const PBKDF2_DKLEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const SCHEMA_VERSION = 1;
// Standard Ethereum BIP-44 path: m/44'/60'/0'/0/0
const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";

interface VaultEnvelope {
  v: number;
  kdf: "pbkdf2-sha256";
  iter: number;
  salt: string;
  nonce: string;
  ct: string;
  addr: string;
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

async function loadVault(): Promise<VaultEnvelope | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([VAULT_KEY], (res) => {
      const v = res?.[VAULT_KEY];
      resolve((v as VaultEnvelope | undefined) ?? null);
    });
  });
}

async function saveVault(envelope: VaultEnvelope): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [VAULT_KEY]: envelope }, () => resolve());
  });
}

// ---- key derivation ----

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const passBytes = new TextEncoder().encode(password);
  return pbkdf2Async(sha256, passBytes, salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: PBKDF2_DKLEN,
  });
}

function privKeyToAddress(priv: Uint8Array): string {
  // Uncompressed public key, drop the 0x04 prefix to get the 64-byte X||Y.
  const pub = getPublicKey(priv, false);
  const xy = pub.slice(1);
  const hash = keccak_256(xy);
  // Address = last 20 bytes of keccak256(pubkey) - matches Ethereum.
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

export async function hasVault(): Promise<boolean> {
  const v = await loadVault();
  return v !== null;
}

export async function getStoredAddress(): Promise<string | null> {
  const v = await loadVault();
  return v?.addr ?? null;
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
  const nonce = randomBytes(NONCE_LEN);
  const dek = await deriveKey(password, salt);
  const cipher = gcm(dek, nonce);
  const ct = cipher.encrypt(priv);

  // Wipe the freshly derived DEK (priv stays in `unlocked`).
  dek.fill(0);

  const envelope: VaultEnvelope = {
    v: SCHEMA_VERSION,
    kdf: "pbkdf2-sha256",
    iter: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ct),
    addr: address,
  };
  await saveVault(envelope);

  unlocked = { privKey: priv, address };
  return address;
}

/**
 * Decrypt the vault and load the private key into memory.
 */
export async function unlock(password: string): Promise<{ address: string }> {
  const v = await loadVault();
  if (!v) throw new Error("no vault — run onboarding first");
  if (v.kdf !== "pbkdf2-sha256") throw new Error(`unsupported kdf: ${v.kdf}`);

  const salt = base64ToBytes(v.salt);
  const nonce = base64ToBytes(v.nonce);
  const ct = base64ToBytes(v.ct);
  const dek = await deriveKey(password, salt);
  let priv: Uint8Array;
  try {
    const cipher = gcm(dek, nonce);
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

function hexOrUtf8ToBytes(s: string): Uint8Array {
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

export const __internal = {
  privKeyToAddress,
  deriveSecp256k1FromMnemonic,
};
