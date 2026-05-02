// Monolythium Wallet — ML-DSA-65 + encrypted-envelope transaction bridge.
//
// The legacy path (`tx.ts` + `keystore.ts.signLegacyTx`) RLP-encodes an
// EIP-155 envelope and signs with secp256k1. Sprintnet refuses that
// envelope at the decoder layer (Law §2.1), AND refuses plaintext
// `bincode(SignedTransaction)` at admission (Law §4.5 / Q2 — the
// genesis default flips `encrypted_mempool_required = true`). So the
// wallet must:
//
//   1. Sign an inner `Transaction` with ML-DSA-65 → `bincode(SignedTransaction)`.
//   2. Fetch the cluster's per-epoch ML-KEM-768 encapsulation key via
//      the `lyth_getEncryptionKey` RPC.
//   3. Wrap the inner bytes in an `EncryptedEnvelope` (ML-KEM-768
//      encapsulate + ChaCha20-Poly1305 AEAD; outer ML-DSA-65 signature
//      over the canonical preimage). See `encrypted-envelope.ts`.
//   4. Submit the bincode-encoded envelope hex via `lyth_submitEncrypted`
//      (NOT `eth_sendRawTransaction` — that endpoint accepts only the
//      pre-Apr-26 plaintext path, which the chain now rejects at admission).
//
// Routing in `service-worker.ts` uses `chainRequiresMlDsa()` to decide
// between this path and the legacy one.

import {
  signEvmTxV3,
  signOuterDigestV3,
  getUnlockedAddressBytesV3,
  getUnlockedPublicKeyV3,
} from "./keystore-mldsa.js";
import { SPRINTNET_VALIDATOR_RPCS } from "./networks.js";
import {
  buildEncryptedEnvelope,
  MempoolClass,
  type DecryptHint,
  type NonceAad,
} from "./encrypted-envelope.js";

/** EIP-1193 `eth_sendTransaction` hex-quantity inputs this bridge accepts. */
export interface EthSendTxFields {
  to?: string;
  value?: string;
  data?: string;
  /** Gas limit (EIP-1193 calls this `gas`). */
  gas: string;
  nonce: string;
  /** Legacy single-fee field; mapped onto `maxFeePerGas` when 1559 fields are absent. */
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  /** Hex chain id of the target chain (e.g. `0x10F2C` for Sprintnet). */
  chainIdHex: string;
}

/** Chain response shape for `lyth_getEncryptionKey`. */
interface SprintnetEncryptionKeyJson {
  algo: string;
  epoch: number | string;
  encapsulationKey: string;
}

/** Decoded form of `lyth_getEncryptionKey` for downstream callers. */
export interface SprintnetEncryptionKey {
  /** Always `"ml-kem-768"` today; surfaced for future scheme bumps. */
  algo: string;
  /** Decrypt epoch — wallets cache this and refresh when admission rejects. */
  epoch: bigint;
  /** Raw 1184-byte ML-KEM-768 encapsulation key. */
  encapsulationKey: Uint8Array;
}

// ---- Hex helpers ----

function parseHexBigInt(s: string | undefined, label: string): bigint {
  if (s === undefined) throw new Error(`${label} missing`);
  const r = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (r.length === 0) return 0n;
  return BigInt("0x" + r);
}

function parseToBytes(s: string | undefined): Uint8Array | null {
  if (s === undefined || s === "" || s === "0x") return null;
  const r = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (r.length === 0) return null;
  if (r.length !== 40) {
    throw new Error(`to must be a 20-byte address (got ${r.length / 2} bytes)`);
  }
  return hexToBytes(r);
}

function parseDataBytes(s: string | undefined): Uint8Array {
  if (s === undefined) return new Uint8Array(0);
  const r = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (r.length === 0) return new Uint8Array(0);
  if (r.length % 2 !== 0) {
    throw new Error(`data hex must have even length (got ${r.length})`);
  }
  return hexToBytes(r);
}

function hexToBytes(stripped: string): Uint8Array {
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex byte");
    out[i] = byte;
  }
  return out;
}

function u128SaturateFromBigInt(value: bigint): bigint {
  const cap = (1n << 128n) - 1n;
  if (value < 0n) return 0n;
  return value > cap ? cap : value;
}

// ---- Sprintnet JSON-RPC ----

/**
 * Iterate the published Sprintnet validators in order, returning the
 * first one that produces a non-error JSON-RPC response. Transport-level
 * failures (timeout, NXDOMAIN, non-2xx, missing result) trigger fallback
 * to the next validator; RPC-level rejections (`{ error: { code, message } }`)
 * propagate immediately — validator state is consensus-shared and a
 * state-level rejection on val-1 is the same on val-N.
 *
 * Both the read-side fee/nonce fetches in service-worker.ts and the
 * encrypted-submit helper below funnel through this so the canonical-
 * alias-is-NXDOMAIN workaround lives in exactly one place.
 */
export async function sprintnetJsonRpc<T>(
  method: string,
  params: unknown[],
): Promise<{ result: T; via: string }> {
  let lastTransportErr: Error | null = null;
  for (const v of SPRINTNET_VALIDATOR_RPCS) {
    let res: Response;
    try {
      res = await fetch(v.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      lastTransportErr = e as Error;
      continue;
    }
    if (!res.ok) {
      lastTransportErr = new Error(`HTTP ${res.status} from ${v.name}`);
      continue;
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { code?: number; message?: string };
    };
    if (body.error) {
      const err = new Error(
        body.error.message ?? `rpc error from ${v.name}`,
      ) as Error & { code?: number; via?: string };
      if (typeof body.error.code === "number") err.code = body.error.code;
      err.via = v.name;
      throw err;
    }
    if (body.result === undefined) {
      lastTransportErr = new Error(`empty result body from ${v.name}`);
      continue;
    }
    return { result: body.result, via: v.name };
  }
  throw lastTransportErr ?? new Error("no Sprintnet validator reachable");
}

/**
 * Fetch the cluster's current ML-KEM-768 encapsulation key via the
 * `lyth_getEncryptionKey` RPC (R3-H10). Wallets call this once per
 * epoch, cache the result, and refresh when admission returns
 * `wrong-epoch` or after a configurable TTL.
 */
export async function fetchSprintnetEncryptionKey(): Promise<SprintnetEncryptionKey> {
  const { result } = await sprintnetJsonRpc<SprintnetEncryptionKeyJson>(
    "lyth_getEncryptionKey",
    [],
  );
  if (typeof result?.encapsulationKey !== "string") {
    throw new Error("lyth_getEncryptionKey: missing encapsulationKey");
  }
  const stripped = result.encapsulationKey.startsWith("0x")
    ? result.encapsulationKey.slice(2)
    : result.encapsulationKey;
  const encapsulationKey = hexToBytes(stripped);
  // Epoch may be a JSON number or a string (some RPC layers stringify
  // big numbers). Coerce to bigint either way.
  const epoch =
    typeof result.epoch === "string"
      ? BigInt(result.epoch.startsWith("0x") ? result.epoch : result.epoch)
      : BigInt(result.epoch);
  return {
    algo: typeof result.algo === "string" ? result.algo : "ml-kem-768",
    epoch,
    encapsulationKey,
  };
}

// ---- Build + submit ----

/**
 * Translate the EIP-1193 hex-quantity request into the bigint shape
 * `signEvmTxV3` consumes. Legacy dapps that send only `gasPrice` get
 * it copied into both 1559 fields — the chain decoder enforces 1559
 * shape regardless, so this is the only reasonable mapping.
 */
function normalizeFields(req: EthSendTxFields): {
  chainId: bigint;
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  to: Uint8Array | null;
  value: bigint;
  input: Uint8Array;
} {
  const maxFeePerGas =
    req.maxFeePerGas !== undefined
      ? parseHexBigInt(req.maxFeePerGas, "maxFeePerGas")
      : parseHexBigInt(req.gasPrice, "gasPrice/maxFeePerGas");
  const maxPriorityFeePerGas =
    req.maxPriorityFeePerGas !== undefined
      ? parseHexBigInt(req.maxPriorityFeePerGas, "maxPriorityFeePerGas")
      : maxFeePerGas;
  return {
    chainId: parseHexBigInt(req.chainIdHex, "chainId"),
    nonce: parseHexBigInt(req.nonce, "nonce"),
    gasLimit: parseHexBigInt(req.gas, "gas"),
    maxFeePerGas,
    maxPriorityFeePerGas,
    to: parseToBytes(req.to),
    value: req.value !== undefined ? parseHexBigInt(req.value, "value") : 0n,
    input: parseDataBytes(req.data),
  };
}

/**
 * Heuristic priority-class selection for an `eth_sendTransaction`:
 * empty-data tx → `Transfer`, anything else → `ContractCall`. The chain
 * doesn't validate the class strictly — it's a hint for ordering and
 * quota — but matching the canonical bucket keeps mempool metrics
 * sensible. Privacy / agent / governance ops route through dedicated
 * wallet flows that pick their own class.
 */
function pickPriorityClass(input: Uint8Array, to: Uint8Array | null): MempoolClass {
  if (to === null) return MempoolClass.ContractCall; // contract creation
  return input.length === 0 ? MempoolClass.Transfer : MempoolClass.ContractCall;
}

/**
 * Sign + wrap an `eth_sendTransaction` into an encrypted envelope ready
 * for `lyth_submitEncrypted`. Caller passes the cached encryption key
 * so the same key can amortize across many txs in a single epoch.
 *
 * The keystore must be unlocked. Returns the wire-ready hex blob plus
 * a sighash for diagnostics — the chain returns the actual tx hash
 * from `lyth_submitEncrypted`, so we don't compute one locally.
 */
export async function buildEncryptedSubmission(args: {
  txReq: EthSendTxFields;
  encryptionKey: SprintnetEncryptionKey;
}): Promise<{
  envelopeWireHex: string;
  innerSighashHex: string;
  innerWireBytes: number;
}> {
  const senderAddress = getUnlockedAddressBytesV3();
  const senderPubkey = getUnlockedPublicKeyV3();
  if (senderAddress === null || senderPubkey === null) {
    throw new Error("v3 wallet is locked");
  }

  const fields = normalizeFields(args.txReq);

  // Step 1 — sign the inner tx. `signEvmTxV3` returns the SDK's
  // `bincode(SignedTransaction)` bytes that the chain decodes via
  // `bincode::deserialize::<SignedTransaction>` after threshold decrypt.
  const signed = await signEvmTxV3({
    chainId: fields.chainId,
    nonce: fields.nonce,
    gasLimit: fields.gasLimit,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    to: fields.to,
    value: fields.value,
    input: fields.input,
  });

  // Step 2 — build the AAD mirroring the inner tx's gas/fee fields
  // EXACTLY (R3-H08 binding rule; mismatches are slashable on reveal).
  // The chain's `NonceAad` carries u128 fee fields; the inner tx
  // signs over U256 fees — saturate to u128 for the AAD. Honest senders
  // never overflow because mainnet fees are well below 2^128.
  const nonceAad: NonceAad = {
    sender: senderAddress,
    nonce: fields.nonce,
    chainId: fields.chainId,
    class: pickPriorityClass(fields.input, fields.to),
    maxFeePerGas: u128SaturateFromBigInt(fields.maxFeePerGas),
    maxPriorityFeePerGas: u128SaturateFromBigInt(fields.maxPriorityFeePerGas),
    gasLimit: fields.gasLimit,
  };

  // Step 3 — encrypt + outer-sign + bincode the envelope.
  const decryptionHint: DecryptHint = {
    epoch: args.encryptionKey.epoch,
    scheme: 0,
  };
  const { wireHex } = await buildEncryptedEnvelope({
    signedInnerTxBincode: signed.bincodeBytes,
    nonceAad,
    decryptionHint,
    kemEncapsulationKey: args.encryptionKey.encapsulationKey,
    senderAddress,
    senderPubkey,
    signOuterDigest: signOuterDigestV3,
  });

  return {
    envelopeWireHex: wireHex,
    innerSighashHex: signed.sighashHex,
    innerWireBytes: signed.wireBytes,
  };
}

/**
 * Submit an encrypted-envelope hex blob via `lyth_submitEncrypted`.
 * The RPC returns the tx hash on success; admission rejections
 * surface as RPC errors and propagate up.
 */
export async function broadcastEncryptedEnvelope(envelopeWireHex: string): Promise<{
  txHash: string;
  via: string;
}> {
  const { result, via } = await sprintnetJsonRpc<string>(
    "lyth_submitEncrypted",
    [envelopeWireHex],
  );
  return { txHash: result, via };
}

/**
 * One-shot helper used by the service worker: fetch the encryption key,
 * sign + wrap, submit. Errors propagate with as much context as the
 * underlying step provides (transport vs admission reject vs decode).
 */
export async function submitEncryptedMlDsaTx(req: EthSendTxFields): Promise<{
  txHash: string;
  via: string;
  innerSighashHex: string;
}> {
  const encryptionKey = await fetchSprintnetEncryptionKey();
  const wrapped = await buildEncryptedSubmission({ txReq: req, encryptionKey });
  const { txHash, via } = await broadcastEncryptedEnvelope(wrapped.envelopeWireHex);
  return { txHash, via, innerSighashHex: wrapped.innerSighashHex };
}
