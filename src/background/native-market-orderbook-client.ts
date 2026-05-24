import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  buildNativeMarketOrderBookReplayQuery,
  validateNativeMarketOrderBookReplayResponse,
  type NativeMarketOrderBookReplayFilter,
  type NativeMarketOrderBookReplayResponse,
} from "../shared/native-market-orderbook.js";
import { getActiveOperators, verifyOperatorGenesis } from "./networks.js";

export async function readNativeMarketOrderBookDeltas(
  filter: NativeMarketOrderBookReplayFilter,
): Promise<ChainOutcome<NativeMarketOrderBookReplayResponse | null>> {
  const query = buildNativeMarketOrderBookReplayQuery(filter);
  if (query === null) {
    return {
      kind: "mock-error",
      data: null,
      via: "mock",
      reason: "/api/v1/native-market-orderbook-deltas: invalid replay filter",
      durationMs: 0,
    };
  }
  return withChainFallback<NativeMarketOrderBookReplayResponse | null>(
    () => fetchNativeMarketOrderBookDeltas(query),
    {
      mockValue: null,
      notLiveAs: "not-deployed",
      label: "/api/v1/native-market-orderbook-deltas",
      timeoutMs: 5000,
      isValid: (raw) => raw !== null,
    },
  );
}

async function fetchNativeMarketOrderBookDeltas(
  query: URLSearchParams,
): Promise<NativeMarketOrderBookReplayResponse | null> {
  let lastTransportErr: Error | null = null;
  for (const operator of getActiveOperators()) {
    if (!(await verifyOperatorGenesis(operator.rpc))) {
      lastTransportErr = new Error(`${operator.name}: untrusted genesis`);
      continue;
    }
    const url = new URL(`${operator.rpc.replace(/\/+$/, "")}/api/v1/native-market-orderbook-deltas`);
    url.search = query.toString();
    let res: Response;
    try {
      res = await fetch(url);
    } catch (cause) {
      lastTransportErr = cause as Error;
      continue;
    }
    if (!res.ok) {
      lastTransportErr = new Error(`HTTP ${res.status} from ${operator.name}`);
      continue;
    }
    const body = (await res.json()) as { data?: unknown; error?: { message?: string } };
    if (body.error !== undefined) {
      throw new Error(body.error.message ?? `api error from ${operator.name}`);
    }
    return validateNativeMarketOrderBookReplayResponse(body.data ?? body);
  }
  throw lastTransportErr ?? new Error("no Sprintnet operator reachable");
}
