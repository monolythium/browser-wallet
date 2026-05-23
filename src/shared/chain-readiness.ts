// Phase 11 — Chain-readiness scaffolding.
//
// The wallet's chain-reader story since Phase 7.1 has been "wrap every
// `lyth_*` call in a try/catch and fall back to a hand-coded mock when
// the call throws". That works, but the per-call duplication is
// significant and the "this is mocked because chain offline" vs "this is
// mocked because chain method doesn't exist yet" distinction is implicit.
//
// `withChainFallback` makes the contract explicit:
//   - one timeout per call (so a hung operator doesn't hang the UI);
//   - a typed `Outcome` envelope distinguishing the success kinds
//     ("live", "mock-offline", "mock-not-deployed", "mock-error");
//   - a `via` string that the popup can render verbatim in dev-only
//     "data source" badges without inventing taxonomies.
//
// This module is dependency-free (no SDK / no chrome / no fetch). It's
// imported by `background/staking-client.ts`, `background/service-worker.ts`,
// and by anything else that wants the same fallback discipline.
//
// Whitepaper alignment: not a §-feature in itself — this is the wiring
// pattern that the v4.0 reframe (Part 1 §10) requires when the wallet
// has to ship UI surfaces ahead of every chain primitive being deployed.

/** Outcome of a chain call that has a coded mock fallback. The `kind`
 *  discriminator lets callers (typically the SW IPC dispatchers) decide
 *  whether to surface a "data is live" badge to the popup. The popup
 *  itself rarely needs to branch on `kind`; the `via` string is enough
 *  for dev-tools display. */
export type ChainOutcome<T> =
  | {
      /** The chain method returned a usable value. */
      kind: "live";
      data: T;
      via: string;
      durationMs: number;
    }
  | {
      /** Chain method exists in the SDK but the call failed with a
       *  transport-level error (timeout, network unreachable, operator
       *  down). Falls back to the caller's mock value. */
      kind: "mock-offline";
      data: T;
      via: "mock";
      reason: string;
      durationMs: number;
    }
  | {
      /** Chain method does not yet exist in the SDK / on the chain. The
       *  caller passed a typed mock value to render the realistic shape
       *  while the chain primitive is in flight. Surfaces in the dev-tools
       *  badge as "mock (chain GAP)" so it's distinguishable from offline. */
      kind: "mock-not-deployed";
      data: T;
      via: "mock";
      reason: string;
      durationMs: number;
    }
  | {
      /** Chain method returned but the response shape didn't match what
       *  the wallet expects (chain side rotated a field, or operator is
       *  on a newer schema). Caller should surface a user-visible
       *  "wallet needs update" hint. */
      kind: "mock-error";
      data: T;
      via: "mock";
      reason: string;
      durationMs: number;
    };

/** Options for `withChainFallback`. */
export interface ChainFallbackOpts<T> {
  /** Mock value to return on failure. Caller is responsible for making
   *  this a realistic shape — the popup must render against it without
   *  branching. */
  mockValue: T;
  /** Reason classifier. Distinguishes the three not-live cases above.
   *  Default is "offline" (the call attempted RPC and threw). */
  notLiveAs?: "offline" | "not-deployed" | "schema-error";
  /** Timeout in milliseconds. Defaults to 8000. The chain call is
   *  considered offline if it doesn't resolve within this window. */
  timeoutMs?: number;
  /** Human-readable label for the chain method. Surfaced in the `via`
   *  string for dev-tools. Defaults to "chain". */
  label?: string;
  /** Optional shape validator. Receives the raw chain result; returning
   *  false routes to `mock-error`. Returning true (or omitting the
   *  validator) treats any non-throw result as live. */
  isValid?: (raw: unknown) => boolean;
}

/** Wrap a chain call with timeout + typed fallback. The returned promise
 *  never throws; failures collapse into a `mock-*` outcome with the
 *  caller-supplied mock value.
 *
 *  Usage:
 *    const out = await withChainFallback(
 *      () => sdkClient.lythAddressActivityKind(addr),
 *      { mockValue: { kind: "indexer_disabled" }, label: "lyth_addressActivityKind" }
 *    );
 *    // out.kind === "live" | "mock-offline" | "mock-not-deployed" | "mock-error"
 *    // out.data is always typed T regardless.
 */
export async function withChainFallback<T>(
  chainCall: () => Promise<T>,
  opts: ChainFallbackOpts<T>,
): Promise<ChainOutcome<T>> {
  const label = opts.label ?? "chain";
  const timeoutMs = opts.timeoutMs ?? 8000;
  const startedAt = Date.now();
  const timeoutOutcome = (): ChainOutcome<T> => ({
    kind: opts.notLiveAs === "not-deployed" ? "mock-not-deployed" : "mock-offline",
    data: opts.mockValue,
    via: "mock",
    reason: `${label}: timeout after ${timeoutMs}ms`,
    durationMs: Date.now() - startedAt,
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<ChainOutcome<T>>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timeoutOutcome()), timeoutMs);
  });

  const callPromise = (async (): Promise<ChainOutcome<T>> => {
    try {
      const raw = await chainCall();
      if (opts.isValid && !opts.isValid(raw)) {
        return {
          kind: "mock-error",
          data: opts.mockValue,
          via: "mock",
          reason: `${label}: response failed shape validation`,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        kind: "live",
        data: raw,
        via: label,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const kind: ChainOutcome<T>["kind"] =
        opts.notLiveAs === "not-deployed"
          ? "mock-not-deployed"
          : opts.notLiveAs === "schema-error"
            ? "mock-error"
            : "mock-offline";
      return {
        kind,
        data: opts.mockValue,
        via: "mock",
        reason: `${label}: ${msg}`,
        durationMs: Date.now() - startedAt,
      };
    }
  })();

  const outcome = await Promise.race([callPromise, timeoutPromise]);
  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  return outcome;
}

/** Convenience: extract just the data without caring about provenance.
 *  Useful for tests + non-UI callers. */
export function chainOutcomeData<T>(out: ChainOutcome<T>): T {
  return out.data;
}

/** Convenience: true when the result came from the chain (not a mock). */
export function isLive<T>(out: ChainOutcome<T>): boolean {
  return out.kind === "live";
}
