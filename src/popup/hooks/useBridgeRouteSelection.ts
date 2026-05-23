import { useMemo } from "react";
import {
  rankBridgeRoutes,
  selectBridgeTransferRoute,
  type BridgeAdminControl,
  type BridgeCircuitBreakerState,
  type BridgeRouteAssessment,
  type BridgeRouteSelection,
  type BridgeRouteDisclosure as SdkBridgeRouteDisclosure,
  type BridgeTransferIntent,
} from "@monolythium/core-sdk";

import type {
  WalletBridgeDisclosureValue,
  WalletBridgeRouteDisclosure,
  WalletBridgeRouteReadiness,
} from "../bg";

type BridgeRouteCandidateState =
  | "selected"
  | "candidate"
  | "blocked"
  | "display-only";

export interface BridgeRouteChoiceCandidate {
  disclosure: WalletBridgeRouteDisclosure;
  originalIndex: number;
  rank: number | null;
  state: BridgeRouteCandidateState;
  route: SdkBridgeRouteDisclosure | null;
  assessment: BridgeRouteAssessment | null;
  parseFailure: string | null;
  bridgeId: string | null;
  wrappedAsset: string | null;
  readiness: WalletBridgeRouteReadiness | null;
}

export interface BridgeRouteChoiceState {
  candidates: BridgeRouteChoiceCandidate[];
  selected: BridgeRouteChoiceCandidate | null;
  blockedReasons: string[];
  sdkRouteCount: number;
  displayOnlyCount: number;
  catalogueReadiness: WalletBridgeRouteReadiness | null;
  transferPreview: BridgeTransferPreviewState;
}

export interface BridgeTransferPreviewState {
  status: "intent-blocked" | "route-blocked" | "no-disclosure";
  intent: BridgeTransferIntent | null;
  selection: BridgeRouteSelection | null;
  blockedReasons: string[];
  quoteBlockedReasons: string[];
  submitBlockedReasons: string[];
  quoteDisabled: boolean;
  submitDisabled: boolean;
  readiness: WalletBridgeRouteReadiness | null;
}

interface SdkRouteRow {
  disclosure: WalletBridgeRouteDisclosure;
  originalIndex: number;
  route: SdkBridgeRouteDisclosure;
  metadata: BridgeRouteCatalogueMetadata;
}

interface DisplayOnlyRouteRow {
  disclosure: WalletBridgeRouteDisclosure;
  originalIndex: number;
  reason: string;
  metadata: BridgeRouteCatalogueMetadata;
}

type SdkRouteParseResult =
  | { ok: true; route: SdkBridgeRouteDisclosure }
  | { ok: false; reason: string };

interface BridgeRouteCatalogueMetadata {
  bridgeId: string | null;
  wrappedAsset: string | null;
  readiness: WalletBridgeRouteReadiness | null;
}

const BRIDGE_ADMIN_CONTROLS = new Set<string>([
  "none",
  "consensusOnly",
  "operatorKey",
  "unknown",
]);

const BRIDGE_CIRCUIT_BREAKERS = new Set<string>([
  "armed",
  "paused",
  "disabled",
  "unknown",
]);

export function buildBridgeRouteChoiceState(
  disclosures: readonly WalletBridgeRouteDisclosure[],
  catalogueReadiness: WalletBridgeRouteReadiness | null = null,
): BridgeRouteChoiceState {
  const sdkRows: SdkRouteRow[] = [];
  const displayOnlyRows: DisplayOnlyRouteRow[] = [];

  disclosures.forEach((disclosure, originalIndex) => {
    const parsed = readSdkBridgeRouteDisclosure(disclosure);
    const metadata = readBridgeRouteCatalogueMetadata(
      disclosure,
      catalogueReadiness,
    );
    if (parsed.ok) {
      sdkRows.push({
        disclosure,
        originalIndex,
        route: parsed.route,
        metadata,
      });
    } else {
      displayOnlyRows.push({
        disclosure,
        originalIndex,
        reason: parsed.reason,
        metadata,
      });
    }
  });

  const rowByRoute = new Map<SdkBridgeRouteDisclosure, SdkRouteRow>();
  for (const row of sdkRows) rowByRoute.set(row.route, row);

  let selected: BridgeRouteChoiceCandidate | null = null;
  const candidates: BridgeRouteChoiceCandidate[] = rankBridgeRoutes(
    sdkRows.map((row) => row.route),
  ).map((ranked, index) => {
    const row = rowByRoute.get(ranked.route);
    if (row === undefined) {
      throw new Error("ranked bridge route did not match source row");
    }

    const candidate: BridgeRouteChoiceCandidate = {
      disclosure: row.disclosure,
      originalIndex: row.originalIndex,
      rank: index + 1,
      state: ranked.assessment.accepted ? "candidate" : "blocked",
      route: ranked.route,
      assessment: ranked.assessment,
      parseFailure: null,
      bridgeId: row.metadata.bridgeId,
      wrappedAsset: row.metadata.wrappedAsset,
      readiness: row.metadata.readiness,
    };

    if (selected === null && ranked.assessment.accepted) {
      candidate.state = "selected";
      selected = candidate;
    }

    return candidate;
  });

  for (const row of displayOnlyRows) {
    candidates.push({
      disclosure: row.disclosure,
      originalIndex: row.originalIndex,
      rank: null,
      state: "display-only",
      route: null,
      assessment: null,
      parseFailure: row.reason,
      bridgeId: row.metadata.bridgeId,
      wrappedAsset: row.metadata.wrappedAsset,
      readiness: row.metadata.readiness,
    });
  }

  const blockedReasons = bridgeRouteChoiceBlockedReasons(
    disclosures.length,
    sdkRows.length,
    selected,
  );
  const transferPreview = buildBridgeTransferPreviewState(
    disclosures.length,
    sdkRows.map((row) => row.route),
    selected,
    blockedReasons,
    catalogueReadiness,
  );

  return {
    candidates,
    selected,
    blockedReasons,
    sdkRouteCount: sdkRows.length,
    displayOnlyCount: displayOnlyRows.length,
    catalogueReadiness,
    transferPreview,
  };
}

export function useBridgeRouteSelection(
  disclosures: readonly WalletBridgeRouteDisclosure[],
  catalogueReadiness: WalletBridgeRouteReadiness | null = null,
): BridgeRouteChoiceState {
  return useMemo(
    () => buildBridgeRouteChoiceState(disclosures, catalogueReadiness),
    [catalogueReadiness, disclosures],
  );
}

function bridgeRouteChoiceBlockedReasons(
  disclosureCount: number,
  sdkRouteCount: number,
  selected: BridgeRouteChoiceCandidate | null,
): string[] {
  if (disclosureCount === 0) return ["no route disclosures supplied"];
  if (sdkRouteCount === 0) {
    return ["no SDK-shaped bridge route disclosures supplied"];
  }
  if (selected === null) {
    return ["no SDK-ranked bridge route satisfies the v4.1 disclosure floor"];
  }
  return [];
}

function buildBridgeTransferPreviewState(
  disclosureCount: number,
  routes: readonly SdkBridgeRouteDisclosure[],
  selected: BridgeRouteChoiceCandidate | null,
  routeBlockedReasons: readonly string[],
  catalogueReadiness: WalletBridgeRouteReadiness | null,
): BridgeTransferPreviewState {
  if (selected?.route == null) {
    const blockedReasons = uniqueStrings([
      ...routeBlockedReasons,
      ...(catalogueReadiness?.blockedReasons ?? []),
    ]);
    const routeMessage =
      disclosureCount === 0
        ? "no route disclosures supplied"
        : "quote preview requires an SDK-selected route";
    if (!blockedReasons.includes(routeMessage)) blockedReasons.push(routeMessage);
    return {
      status: disclosureCount === 0 ? "no-disclosure" : "route-blocked",
      intent: null,
      selection: null,
      blockedReasons,
      quoteBlockedReasons: bridgeQuoteBlockedReasons(
        catalogueReadiness,
        "live bridge quote is blocked until a route satisfies the SDK disclosure floor",
      ),
      submitBlockedReasons: bridgeSubmitBlockedReasons(
        catalogueReadiness,
        "live bridge submit is blocked until quote and submit API primitives are available",
      ),
      quoteDisabled: true,
      submitDisabled: true,
      readiness: catalogueReadiness,
    };
  }

  const intent: BridgeTransferIntent = {
    asset: selected.route.asset,
    amountAtomic: "",
    sourceChain: selected.route.sourceChain,
    destinationChain: selected.route.destinationChain,
    recipient: "",
    allowedRouteIds: [selected.route.routeId],
  };
  const selection = selectBridgeTransferRoute(intent, routes);
  const readiness = selected.readiness ?? catalogueReadiness;
  const blockedReasons = uniqueStrings([
    ...selection.blockedReasons,
    ...(readiness?.blockedReasons ?? []),
  ]);

  return {
    status: "intent-blocked",
    intent,
    selection,
    blockedReasons,
    quoteBlockedReasons: bridgeQuoteBlockedReasons(
      readiness,
      "standalone SDK exposes route-intent selection only; no live bridge quote helper or API route is available",
    ),
    submitBlockedReasons: bridgeSubmitBlockedReasons(
      readiness,
      "standalone SDK exposes no live bridge submit helper or API route",
    ),
    quoteDisabled: true,
    submitDisabled: true,
    readiness,
  };
}

function bridgeQuoteBlockedReasons(
  readiness: WalletBridgeRouteReadiness | null,
  baseReason: string,
): string[] {
  const reasons =
    readiness?.quoteReady === false
      ? ["catalogue readiness reports quote disabled"]
      : [];
  reasons.push(baseReason);
  return uniqueStrings(reasons);
}

function bridgeSubmitBlockedReasons(
  readiness: WalletBridgeRouteReadiness | null,
  baseReason: string,
): string[] {
  const reasons =
    readiness?.submitReady === false
      ? ["catalogue readiness reports submit disabled"]
      : [];
  reasons.push(baseReason);
  return uniqueStrings(reasons);
}

function readBridgeRouteCatalogueMetadata(
  disclosure: WalletBridgeRouteDisclosure,
  fallbackReadiness: WalletBridgeRouteReadiness | null,
): BridgeRouteCatalogueMetadata {
  return {
    bridgeId: readNullableStringAlias(disclosure, [
      "bridgeId",
      "bridge_id",
      "trustedBridgeId",
      "trusted_bridge_id",
      "bridgeConfigId",
      "bridge_config_id",
    ]),
    wrappedAsset: readNullableStringAlias(disclosure, [
      "wrappedAsset",
      "wrapped_asset",
      "wrappedAssetId",
      "wrapped_asset_id",
      "wrappedToken",
      "wrapped_token",
    ]),
    readiness: readBridgeRouteReadiness(disclosure) ?? fallbackReadiness,
  };
}

function readBridgeRouteReadiness(
  disclosure: WalletBridgeRouteDisclosure,
): WalletBridgeRouteReadiness | null {
  const routeSelectionReady = readBooleanAlias(disclosure, [
    "routeSelectionReady",
    "route_selection_ready",
  ]);
  const quoteReady = readBooleanAlias(disclosure, ["quoteReady", "quote_ready"]);
  const submitReady = readBooleanAlias(disclosure, [
    "submitReady",
    "submit_ready",
  ]);
  const blockedReasons = readStringListAlias(disclosure, [
    "readinessBlockedReasons",
    "blockedReasons",
    "blocked_reasons",
  ]);
  const warnings = readStringListAlias(disclosure, [
    "readinessWarnings",
    "warnings",
  ]);

  if (
    routeSelectionReady === null &&
    quoteReady === null &&
    submitReady === null &&
    blockedReasons.length === 0 &&
    warnings.length === 0
  ) {
    return null;
  }

  return {
    routeSelectionReady: routeSelectionReady ?? false,
    quoteReady: quoteReady ?? false,
    submitReady: submitReady ?? false,
    blockedReasons,
    warnings,
  };
}

function readNullableStringAlias(
  disclosure: WalletBridgeRouteDisclosure,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const value = disclosure[alias];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function readBooleanAlias(
  disclosure: WalletBridgeRouteDisclosure,
  aliases: readonly string[],
): boolean | null {
  for (const alias of aliases) {
    const value = disclosure[alias];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function readStringListAlias(
  disclosure: WalletBridgeRouteDisclosure,
  aliases: readonly string[],
): string[] {
  for (const alias of aliases) {
    const value = disclosure[alias];
    if (!Array.isArray(value)) continue;
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") return [];
      out.push(item);
    }
    return out;
  }
  return [];
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function readSdkBridgeRouteDisclosure(
  disclosure: WalletBridgeRouteDisclosure,
): SdkRouteParseResult {
  const routeId = readString(disclosure, "routeId");
  if (routeId === null) return invalid("routeId");
  const bridge = readString(disclosure, "bridge");
  if (bridge === null) return invalid("bridge");
  const asset = readString(disclosure, "asset");
  if (asset === null) return invalid("asset");
  const sourceChain = readString(disclosure, "sourceChain");
  if (sourceChain === null) return invalid("sourceChain");
  const destinationChain = readString(disclosure, "destinationChain");
  if (destinationChain === null) return invalid("destinationChain");
  const verifier = readVerifier(disclosure.verifier);
  if (verifier === null) return invalid("verifier");
  const drainCapAtomic = readString(disclosure, "drainCapAtomic");
  if (drainCapAtomic === null) return invalid("drainCapAtomic");
  const finalityBlocks = readNonNegativeInteger(disclosure, "finalityBlocks");
  if (finalityBlocks === null) return invalid("finalityBlocks");
  const cooldownSeconds = readNonNegativeInteger(disclosure, "cooldownSeconds");
  if (cooldownSeconds === null) return invalid("cooldownSeconds");
  const adminControl = readAdminControl(disclosure.adminControl);
  if (adminControl === null) return invalid("adminControl");
  const circuitBreaker = readCircuitBreaker(disclosure.circuitBreaker);
  if (circuitBreaker === null) return invalid("circuitBreaker");
  const insuranceAtomic = readString(disclosure, "insuranceAtomic");
  if (insuranceAtomic === null) return invalid("insuranceAtomic");
  const lastIncidentDate = readOptionalIncidentDate(disclosure.lastIncidentDate);
  if (lastIncidentDate === undefined) return invalid("lastIncidentDate");

  const route: SdkBridgeRouteDisclosure = {
    routeId,
    bridge,
    asset,
    sourceChain,
    destinationChain,
    verifier,
    drainCapAtomic,
    finalityBlocks,
    cooldownSeconds,
    adminControl,
    circuitBreaker,
    insuranceAtomic,
  };
  if (lastIncidentDate !== "absent") {
    route.lastIncidentDate = lastIncidentDate;
  }
  return { ok: true, route };
}

function invalid(field: string): SdkRouteParseResult {
  return { ok: false, reason: `missing or invalid SDK route field: ${field}` };
}

function isDisclosureObject(
  value: WalletBridgeDisclosureValue | undefined,
): value is Record<string, WalletBridgeDisclosureValue> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function readString(
  disclosure: WalletBridgeRouteDisclosure,
  key: string,
): string | null {
  const value = disclosure[key];
  return typeof value === "string" ? value : null;
}

function readNonNegativeInteger(
  disclosure: WalletBridgeRouteDisclosure,
  key: string,
): number | null {
  const value = disclosure[key];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

function readVerifier(
  value: WalletBridgeDisclosureValue | undefined,
): SdkBridgeRouteDisclosure["verifier"] | null {
  if (!isDisclosureObject(value)) return null;
  const model = value.model;
  const participantCount = value.participantCount;
  const threshold = value.threshold;
  if (typeof model !== "string") return null;
  if (
    typeof participantCount !== "number" ||
    !Number.isInteger(participantCount) ||
    participantCount < 0
  ) {
    return null;
  }
  if (
    typeof threshold !== "number" ||
    !Number.isInteger(threshold) ||
    threshold < 0
  ) {
    return null;
  }
  return { model, participantCount, threshold };
}

function readAdminControl(
  value: WalletBridgeDisclosureValue | undefined,
): BridgeAdminControl | null {
  return typeof value === "string" && BRIDGE_ADMIN_CONTROLS.has(value)
    ? (value as BridgeAdminControl)
    : null;
}

function readCircuitBreaker(
  value: WalletBridgeDisclosureValue | undefined,
): BridgeCircuitBreakerState | null {
  return typeof value === "string" && BRIDGE_CIRCUIT_BREAKERS.has(value)
    ? (value as BridgeCircuitBreakerState)
    : null;
}

function readOptionalIncidentDate(
  value: WalletBridgeDisclosureValue | undefined,
): string | null | "absent" | undefined {
  if (value === undefined) return "absent";
  if (value === null || typeof value === "string") return value;
  return undefined;
}
