import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  validateWalletBridgeRouteDisclosure,
  validateWalletBridgeRouteDisclosureList,
  validateWalletBridgeRouteReadiness,
  type WalletBridgeRouteDisclosure,
  type WalletBridgeRoutesCatalogue,
} from "../shared/token-balances.js";
import { sprintnetJsonRpc } from "./tx-mldsa.js";

const EMPTY_BRIDGE_ROUTES: WalletBridgeRoutesCatalogue = {
  bridgeRouteDisclosures: [],
  readiness: null,
};
const BRIDGE_ROUTE_RESPONSE_FIELDS = [
  "routes",
  "bridgeRouteDisclosures",
  "bridgeRoutes",
  "routeDisclosures",
  "bridge_route_disclosures",
  "bridge_routes",
  "route_disclosures",
] as const;

export function normaliseBridgeRoutesResponse(
  input: unknown,
): WalletBridgeRoutesCatalogue | null {
  if (Array.isArray(input)) {
    return {
      bridgeRouteDisclosures: dedupeWalletBridgeRouteDisclosures(
        validateWalletBridgeRouteDisclosureList(input),
      ),
      readiness: null,
    };
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const r = input as Record<string, unknown>;
  if (typeof r.routeId === "string") {
    const single = validateWalletBridgeRouteDisclosure(input);
    return single === null
      ? null
      : {
          bridgeRouteDisclosures: [single],
          readiness: validateWalletBridgeRouteReadiness(input),
        };
  }

  const readiness = validateWalletBridgeRouteReadiness(input);
  let sawRouteField = false;
  const routes: WalletBridgeRouteDisclosure[] = [];
  for (const field of BRIDGE_ROUTE_RESPONSE_FIELDS) {
    const value = r[field];
    if (value !== undefined) {
      sawRouteField = true;
      routes.push(...validateWalletBridgeRouteDisclosureList(value));
    }
  }

  if (!sawRouteField && readiness === null) return null;
  return {
    bridgeRouteDisclosures: dedupeWalletBridgeRouteDisclosures(routes),
    readiness,
  };
}

export function isBridgeRoutesResponse(input: unknown): boolean {
  return normaliseBridgeRoutesResponse(input) !== null;
}

export async function readBridgeRoutes(): Promise<
  ChainOutcome<WalletBridgeRoutesCatalogue>
> {
  return withChainFallback<WalletBridgeRoutesCatalogue>(
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
      isValid: isBridgeRoutesCatalogue,
    },
  );
}

function isBridgeRoutesCatalogue(input: unknown): input is WalletBridgeRoutesCatalogue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Array.isArray((input as WalletBridgeRoutesCatalogue).bridgeRouteDisclosures);
}

function dedupeWalletBridgeRouteDisclosures(
  disclosures: readonly WalletBridgeRouteDisclosure[],
): WalletBridgeRouteDisclosure[] {
  const seen = new Set<string>();
  const out: WalletBridgeRouteDisclosure[] = [];
  for (const disclosure of disclosures) {
    const key =
      typeof disclosure.routeId === "string"
        ? `routeId:${disclosure.routeId}`
        : `json:${JSON.stringify(disclosure)}`;
    if (seen.has(key)) {
      const index = out.findIndex((row) => {
        const rowKey =
          typeof row.routeId === "string"
            ? `routeId:${row.routeId}`
            : `json:${JSON.stringify(row)}`;
        return rowKey === key;
      });
      if (index >= 0) {
        out[index] = mergeBridgeRouteDisclosure(out[index]!, disclosure);
      }
      continue;
    }
    seen.add(key);
    out.push(disclosure);
  }
  return out;
}

function mergeBridgeRouteDisclosure(
  primary: WalletBridgeRouteDisclosure,
  secondary: WalletBridgeRouteDisclosure,
): WalletBridgeRouteDisclosure {
  const merged: WalletBridgeRouteDisclosure = { ...primary };
  for (const [key, value] of Object.entries(secondary)) {
    if (merged[key] === undefined || merged[key] === null) {
      merged[key] = value;
    }
  }
  return merged;
}
