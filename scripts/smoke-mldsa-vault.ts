#!/usr/bin/env node
// Monolythium Wallet — ML-DSA-65 + encrypted-mempool smoke test.
//
// End-to-end exercise of the wallet's submit pipeline against Sprintnet:
//
//   1. Probe the published validator list, pick the first that answers
//      `net_version` with the expected chain id.
//   2. Generate a fresh 32-byte ML-DSA-65 seed, derive the address.
//   3. Fetch `lyth_getEncryptionKey` from the live validator. The
//      response carries `{ algo: "ml-kem-768", epoch, encapsulationKey }`.
//   4. Build a minimal `Transaction` (21k-gas transfer to 0x1111…11),
//      sign it with the freshly-derived ML-DSA-65 keypair, and produce
//      `bincode(SignedTransaction)`.
//   5. Wrap that into the `EncryptedEnvelope` shape the chain accepts:
//      ML-KEM-768 encapsulate to the cluster pubkey, ChaCha20-Poly1305
//      AEAD over the inner bytes (AAD = `domain_tag || bincode(NonceAad)`),
//      outer ML-DSA-65 signature over the canonical preimage.
//   6. Submit via `lyth_submitEncrypted([envelopeHex])`.
//
// Expected outcomes (any of these is information):
//   - `result: "0x<txhash>"` — chain accepted the envelope and admitted
//     the inner tx (sender has no balance, so subsequent execution will
//     revert, but the wire path is OK).
//   - `error.code` in -32020..-32049 with a typed admission rejection
//     (insufficient balance, nonce gap, etc.) — same conclusion: wire
//     format is valid, only state-level checks failed.
//   - Decoder-level / decrypt-level rejection — wire format drift.
//     Hard fail; print enough context to diagnose.
//
// Usage: `node scripts/smoke-mldsa-vault.ts`  (Node 24+ — built-in TS strip)
//        `npx tsx scripts/smoke-mldsa-vault.ts` (any Node 18+, requires tsx)
//
// File extension is .ts (originally scoped as .mjs) so the script can
// import the wallet's networks module directly. Protocol wire-format
// helpers come from @monolythium/core-sdk/crypto so the smoke path and
// runtime path share the SDK-owned implementation.

import { MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import {
  buildEncryptedEnvelope,
  MempoolClass,
} from "@monolythium/core-sdk/crypto";
import {
  SPRINTNET_VALIDATOR_RPCS,
  SPRINTNET_CHAIN_ID,
} from "../src/background/networks.ts";
import { webcrypto } from "node:crypto";

const TO_ADDRESS_HEX = "11".repeat(20);
const PASS_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADMISSION_REJECT_CODE_LO = -32049;
const ADMISSION_REJECT_CODE_HI = -32020;

async function main() {
  // ---- Step 1: pick a live validator ----
  const validator = await pickFirstAlive(SPRINTNET_VALIDATOR_RPCS);
  if (!validator) {
    console.error("no Sprintnet validator answered net_version with chain id 69420");
    process.exit(2);
  }
  console.log(`live validator: ${validator.name} (${validator.rpc})`);

  // ---- Step 2: fresh keypair ----
  const seed = new Uint8Array(32);
  webcrypto.getRandomValues(seed);
  const backend = MlDsa65Backend.fromSeed(seed);
  const senderHex = await backend.getAddress();
  const senderBytes = backend.addressBytes();
  const senderPubkey = backend.publicKey();
  console.log(`seed (ephemeral, do not reuse): 0x${bytesToHex(seed)}`);
  console.log(`derived address:                ${senderHex}`);

  // ---- Step 3: fetch cluster encryption key ----
  let kemResponse;
  try {
    kemResponse = await rpcCall(validator.rpc, "lyth_getEncryptionKey", []);
  } catch (e) {
    console.error(
      `\nFAIL — lyth_getEncryptionKey rejected by ${validator.name}:`,
      e?.message ?? e,
    );
    console.error(
      "        the chain may not have the encryption-key surface wired here.",
    );
    process.exit(2);
  }
  if (typeof kemResponse?.encapsulationKey !== "string") {
    console.error(
      "FAIL — lyth_getEncryptionKey response missing `encapsulationKey`:",
      JSON.stringify(kemResponse),
    );
    process.exit(2);
  }
  const encapsulationKey = hexToBytes(stripHex(kemResponse.encapsulationKey));
  const epoch = BigInt(kemResponse.epoch ?? 0);
  console.log(
    `cluster KEM:  algo=${kemResponse.algo} epoch=${epoch} ek_bytes=${encapsulationKey.length}`,
  );

  // ---- Step 4: build + sign inner tx ----
  const chainId = BigInt(SPRINTNET_CHAIN_ID);
  const nonce = 0n;
  const maxFeePerGas = 10n ** 9n; // 1 gwei
  const maxPriorityFeePerGas = 10n ** 9n;
  const gasLimit = 21000n;
  const toBytes = hexToBytes(TO_ADDRESS_HEX);
  const innerSigned = backend.signEvmTx({
    chainId,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    to: toBytes,
    value: 0n,
    input: new Uint8Array(0),
  });
  console.log(`inner sighash: 0x${bytesToHex(innerSigned.sighash)}`);
  console.log(`inner wire bytes: ${innerSigned.wireBytes.length}`);

  // ---- Step 5: wrap into encrypted envelope ----
  const nonceAad = {
    sender: senderBytes,
    nonce,
    chainId,
    class: MempoolClass.Transfer,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
  };
  const decryptionHint = { epoch, scheme: 0 };
  const { wireBytes: envelopeBytes, wireHex: envelopeHex } =
    await buildEncryptedEnvelope({
      signedInnerTxBincode: innerSigned.wireBytes,
      nonceAad,
      decryptionHint,
      kemEncapsulationKey: encapsulationKey,
      senderAddress: senderBytes,
      senderPubkey,
      signOuterDigest: (digest) => backend.signPrehash(digest),
    });
  console.log(`envelope wire bytes: ${envelopeBytes.length}`);
  console.log(`envelope hex prefix: ${envelopeHex.slice(0, 80)}…`);

  // ---- Step 6: submit ----
  console.log(`\nPOST ${validator.rpc} lyth_submitEncrypted`);
  let body;
  try {
    body = await rpcRawCall(validator.rpc, "lyth_submitEncrypted", [envelopeHex]);
  } catch (e) {
    console.error(`\nFAIL — transport error: ${e?.message ?? e}`);
    process.exit(2);
  }
  console.log("response:", JSON.stringify(body, null, 2));

  if (typeof body?.result === "string" && PASS_TX_HASH_RE.test(body.result)) {
    console.log(
      "\nPASS — chain accepted the encrypted envelope and returned a tx hash.",
    );
    console.log(
      "        Wire format, ML-DSA-65 outer signature, and ML-KEM-768/AEAD ciphertext all valid.",
    );
    process.exit(0);
  }
  if (body?.error) {
    const code = body.error.code;
    const msg = body.error.message ?? "";
    if (
      typeof code === "number" &&
      code >= ADMISSION_REJECT_CODE_LO &&
      code <= ADMISSION_REJECT_CODE_HI
    ) {
      console.log(
        `\nPASS (admission-only) — chain decoded the envelope but refused for a state reason:`,
      );
      console.log(`        code=${code} message="${msg}"`);
      console.log(
        "        Wire format, signature, and decrypt all valid; only state-level gates rejected.",
      );
      process.exit(0);
    }
    console.error(`\nFAIL — code=${code} message="${msg}"`);
    console.error(
      "        Inspect the message: a decoder/decrypt-level reject means the wire format drifted.",
    );
    process.exit(1);
  }
  console.error("\nFAIL — unexpected response shape:", JSON.stringify(body));
  process.exit(1);
}

// ---- helpers ----

async function pickFirstAlive(validators) {
  for (const v of validators) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(v.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "net_version", params: [] }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const body = await res.json();
      if (Number(body?.result ?? 0) === SPRINTNET_CHAIN_ID) {
        return v;
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function rpcRawCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${rpcUrl}`);
  }
  return await res.json();
}

async function rpcCall(rpcUrl, method, params) {
  const body = await rpcRawCall(rpcUrl, method, params);
  if (body?.error) {
    const e = new Error(body.error.message ?? `rpc error ${method}`);
    e.code = body.error.code;
    throw e;
  }
  return body.result;
}

function stripHex(s) {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function hexToBytes(stripped) {
  if (stripped.length % 2 !== 0) {
    throw new Error(`hex length must be even, got ${stripped.length}`);
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

main().catch((e) => {
  console.error("crash:", e);
  process.exit(2);
});
