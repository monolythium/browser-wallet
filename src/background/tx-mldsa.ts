// Monolythium Wallet — ML-DSA-65 encrypted-submit bridge.
//
// Protocol-critical signing, native tx encoding, and encrypted-envelope
// construction live in `@monolythium/core-sdk/crypto`. This module keeps
// browser-wallet responsibilities local: translate EIP-1193 fields,
// iterate Sprintnet operator RPCs, and surface wallet-friendly errors.

import {
  buildEncryptedSubmission as sdkBuildEncryptedSubmission,
  type EncryptionKey,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { getUnlockedBackendV4 } from "./keystore-mldsa.js";
import { getActiveOperators } from "./networks.js";

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
export interface SprintnetEncryptionKey extends EncryptionKey {}

function hexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (stripped.length % 2 !== 0) {
    throw new Error("hex must have even length");
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("invalid hex byte");
    out[i] = b;
  }
  return out;
}

/**
 * Iterate the published Sprintnet operators in order, returning the
 * first one that produces a non-error JSON-RPC response. Transport-level
 * failures trigger fallback to the next operator; RPC-level rejections
 * propagate immediately because they are state-level consensus answers.
 */
export async function sprintnetJsonRpc<T>(
  method: string,
  params: unknown[],
): Promise<{ result: T; via: string }> {
  let lastTransportErr: Error | null = null;
  for (const v of getActiveOperators()) {
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
      const err = new Error(body.error.message ?? `rpc error from ${v.name}`) as Error & {
        code?: number;
        via?: string;
      };
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
  throw lastTransportErr ?? new Error("no Sprintnet operator reachable");
}

/** Fetch the cluster's current ML-KEM-768 encapsulation key. */
export async function fetchSprintnetEncryptionKey(): Promise<SprintnetEncryptionKey> {
  const { result } = await sprintnetJsonRpc<SprintnetEncryptionKeyJson>(
    "lyth_getEncryptionKey",
    [],
  );
  if (typeof result?.encapsulationKey !== "string") {
    throw new Error("lyth_getEncryptionKey: missing encapsulationKey");
  }
  const epoch =
    typeof result.epoch === "string"
      ? BigInt(result.epoch.startsWith("0x") ? result.epoch : result.epoch)
      : BigInt(result.epoch);
  return {
    algo: typeof result.algo === "string" ? result.algo : "ml-kem-768",
    epoch,
    encapsulationKey: hexToBytes(result.encapsulationKey),
  };
}

function normalizeFields(req: EthSendTxFields): NativeEvmTxFields {
  const maxFeePerGas = req.maxFeePerGas ?? req.gasPrice;
  if (maxFeePerGas === undefined) throw new Error("maxFeePerGas/gasPrice missing");
  return {
    chainId: req.chainIdHex,
    nonce: req.nonce,
    gasLimit: req.gas,
    maxFeePerGas,
    maxPriorityFeePerGas: req.maxPriorityFeePerGas ?? maxFeePerGas,
    to: req.to ?? null,
    value: req.value ?? "0x0",
    input: req.data ?? "0x",
  };
}

/**
 * Sign + wrap an `eth_sendTransaction` into an encrypted envelope ready
 * for `lyth_submitEncrypted`.
 */
export async function buildEncryptedSubmission(args: {
  txReq: EthSendTxFields;
  encryptionKey: SprintnetEncryptionKey;
}): Promise<{
  envelopeWireHex: string;
  innerSighashHex: string;
  innerWireBytes: number;
}> {
  const backend = getUnlockedBackendV4();
  if (backend === null) {
    throw new Error("v3 wallet is locked");
  }
  return sdkBuildEncryptedSubmission({
    backend,
    tx: normalizeFields(args.txReq),
    encryptionKey: args.encryptionKey,
  });
}

/** Submit an encrypted-envelope hex blob via `lyth_submitEncrypted`. */
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

/** One-shot helper used by the service worker. */
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
