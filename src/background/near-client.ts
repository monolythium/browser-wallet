// Minimal NEAR read client for bridge/read-only wallet surfaces.
//
// This module deliberately contains no signing support. NEAR account control
// is not PQ-native today, so writes stay out of scope until a route policy
// explicitly permits them.

export interface NearStatus {
  chain_id: string;
  latest_protocol_version: number;
  protocol_version: number;
  rpc_addr?: string;
  sync_info: {
    latest_block_hash: string;
    latest_block_height: number;
    latest_state_root: string;
    latest_block_time: string;
    syncing: boolean;
  };
  validators: Array<{ account_id: string; is_slashed: boolean }>;
}

export interface NearViewAccount {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  storage_paid_at: number;
  block_height: number;
  block_hash: string;
}

export interface NearRpcError {
  name?: string;
  cause?: unknown;
  code?: number;
  message?: string;
  data?: unknown;
}

interface NearRpcResponse<T> {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: NearRpcError;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function rpcBase(rpcUrl: string): string {
  return rpcUrl.replace(/\/+$/, "");
}

export async function nearStatus(
  rpcUrl: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<NearStatus> {
  const res = await fetchImpl(`${rpcBase(rpcUrl)}/status`);
  if (!res.ok) {
    throw new Error(`NEAR status failed: HTTP ${res.status}`);
  }
  return await res.json() as NearStatus;
}

export async function nearJsonRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown,
  fetchImpl: FetchLike = defaultFetch,
): Promise<T> {
  const res = await fetchImpl(rpcBase(rpcUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "monolythium-wallet",
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(`NEAR RPC ${method} failed: HTTP ${res.status}`);
  }

  const body = await res.json() as NearRpcResponse<T>;
  if (body.error) {
    const message = body.error.message ?? body.error.name ?? "unknown NEAR RPC error";
    throw new Error(`NEAR RPC ${method} failed: ${message}`);
  }
  if (body.result === undefined) {
    throw new Error(`NEAR RPC ${method} returned no result`);
  }
  return body.result;
}

export async function nearViewAccount(
  rpcUrl: string,
  accountId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<NearViewAccount> {
  return nearJsonRpc<NearViewAccount>(
    rpcUrl,
    "query",
    {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    },
    fetchImpl,
  );
}

export async function nearViewFtBalance(
  rpcUrl: string,
  contractId: string,
  accountId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string> {
  const result = await nearJsonRpc<{ result: number[] }>(
    rpcUrl,
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: "ft_balance_of",
      args_base64: jsonToBase64Utf8({ account_id: accountId }),
    },
    fetchImpl,
  );

  if (!Array.isArray(result.result)) {
    throw new Error("NEAR ft_balance_of returned malformed bytes");
  }
  const decoded = new TextDecoder().decode(new Uint8Array(result.result));
  const parsed = JSON.parse(decoded) as unknown;
  if (typeof parsed !== "string") {
    throw new Error("NEAR ft_balance_of returned a non-string balance");
  }
  return parsed;
}

function jsonToBase64Utf8(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

