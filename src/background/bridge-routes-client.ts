import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  validateWalletBridgeRouteDisclosureList,
  type WalletBridgeRouteDisclosure,
} from "../shared/token-balances.js";
import { sprintnetJsonRpc } from "./tx-mldsa.js";

const EMPTY_BRIDGE_ROUTES: WalletBridgeRouteDisclosure[] = [];

export function normaliseBridgeRoutesResponse(
  input: unknown,
): WalletBridgeRouteDisclosure[] | null {
  if (Array.isArray(input)) {
    return validateWalletBridgeRouteDisclosureList(input);
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const r = input as Record<string, unknown>;
  if (typeof r.routeId === "string") {
    const single = validateWalletBridgeRouteDisclosureList(input);
    return single.length > 0 ? single : null;
  }

  const fromRoutes = validateWalletBridgeRouteDisclosureList(r.routes);
  if (fromRoutes.length > 0 || Array.isArray(r.routes)) return fromRoutes;

  const fromDisclosures = validateWalletBridgeRouteDisclosureList(
    r.bridgeRouteDisclosures,
  );
  if (fromDisclosures.length > 0 || Array.isArray(r.bridgeRouteDisclosures)) {
    return fromDisclosures;
  }

  return null;
}

export function isBridgeRoutesResponse(input: unknown): boolean {
  return normaliseBridgeRoutesResponse(input) !== null;
}

export async function readBridgeRoutes(): Promise<
  ChainOutcome<WalletBridgeRouteDisclosure[]>
> {
  return withChainFallback<WalletBridgeRouteDisclosure[]>(
    async () => {
      const { result } = await sprintnetJsonRpc<unknown>("lyth_bridgeRoutes", []);
      const routes = normaliseBridgeRoutesResponse(result);
      if (routes === null) {
        throw new Error("malformed lyth_bridgeRoutes response");
      }
      return routes;
    },
    {
      mockValue: EMPTY_BRIDGE_ROUTES,
      notLiveAs: "not-deployed",
      label: "lyth_bridgeRoutes",
      timeoutMs: 5000,
      isValid: Array.isArray,
    },
  );
}
