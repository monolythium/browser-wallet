import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  buildNativeAgentStateRpcFilter,
  validateNativeAgentStateResponse,
  type NativeAgentStateFilter,
  type NativeAgentStateResponse,
} from "../shared/native-agent-state.js";
import { testnetJsonRpc } from "./tx-mldsa.js";

export async function readNativeAgentState(
  filter: NativeAgentStateFilter = {},
): Promise<ChainOutcome<NativeAgentStateResponse | null>> {
  const rpcFilter = buildNativeAgentStateRpcFilter(filter);
  return withChainFallback<NativeAgentStateResponse | null>(
    async () => {
      const { result } = await testnetJsonRpc<unknown>(
        "lyth_nativeAgentState",
        [rpcFilter],
      );
      return validateNativeAgentStateResponse(result);
    },
    {
      mockValue: null,
      notLiveAs: "not-deployed",
      label: "lyth_nativeAgentState",
      timeoutMs: 5000,
      isValid: (raw) => raw !== null,
    },
  );
}
