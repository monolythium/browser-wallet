import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  buildNativeMarketStateRpcFilter,
  validateNativeMarketStateResponse,
  type NativeMarketStateFilter,
  type NativeMarketStateResponse,
} from "../shared/native-market-state.js";
import { sprintnetJsonRpc } from "./tx-mldsa.js";

export async function readNativeMarketState(
  filter: NativeMarketStateFilter = {},
): Promise<ChainOutcome<NativeMarketStateResponse | null>> {
  const rpcFilter = buildNativeMarketStateRpcFilter(filter);
  return withChainFallback<NativeMarketStateResponse | null>(
    async () => {
      const { result } = await sprintnetJsonRpc<unknown>(
        "lyth_nativeMarketState",
        [rpcFilter],
      );
      return validateNativeMarketStateResponse(result);
    },
    {
      mockValue: null,
      notLiveAs: "not-deployed",
      label: "lyth_nativeMarketState",
      timeoutMs: 5000,
      isValid: (raw) => raw !== null,
    },
  );
}
