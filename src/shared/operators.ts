// Sprintnet operator override — types, storage key, and the merge function
// shared between the service worker (which iterates operators on RPC dispatch)
// and the popup (which renders the override-management UI).
//
// Sprintnet has 6 hardcoded default operator RPCs (see networks.ts:
// SPRINTNET_OPERATOR_RPCS_DEFAULTS; the original operator-1 was dropped
// per the 2026-05-11 regenesis, see that file's docstring). Power users
// can override that list with their own operator nodes; the override is
// persisted to chrome.storage.local and merged at lookup time. Absence
// of the key (or null value) means "use the defaults".

/**
 * Storage key for the user-configured operator override. Lives in
 * chrome.storage.local. Value is OperatorEntry[] (non-empty array) when
 * an override is set, or absent when the user wants defaults.
 */
export const STORAGE_KEY_OPERATOR_OVERRIDE = "mono.operators.override";

/**
 * Single operator entry. Mirrors the shape of SPRINTNET_OPERATOR_RPCS_DEFAULTS
 * in networks.ts so the merge function can flip between defaults and override
 * without per-call shape adapters.
 */
export interface OperatorEntry {
  name: string;
  region: string;
  rpc: string;
}

/**
 * Validate an unknown input as an OperatorEntry[]. Returns the validated
 * list on success, null on any structural failure. Used by the SW
 * sprintnet-operators-set IPC handler as defense-in-depth on top of the
 * popup's client-side form validation.
 *
 * Validation rules:
 *   - Must be a non-empty array.
 *   - Each entry must have non-empty `name` (1-64 chars), `region` string
 *     (0-32 chars; allow blank for the user-supplied case), and a `rpc`
 *     that parses via `new URL()`.
 */
export function validateOperatorList(input: unknown): OperatorEntry[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: OperatorEntry[] = [];
  for (const entry of input) {
    if (entry === null || typeof entry !== "object") return null;
    const e = entry as { name?: unknown; region?: unknown; rpc?: unknown };
    if (typeof e.name !== "string" || e.name.length === 0 || e.name.length > 64) {
      return null;
    }
    if (typeof e.region !== "string" || e.region.length > 32) {
      return null;
    }
    if (typeof e.rpc !== "string") return null;
    try {
      // eslint-disable-next-line no-new
      new URL(e.rpc);
    } catch {
      return null;
    }
    out.push({ name: e.name, region: e.region, rpc: e.rpc });
  }
  return out;
}

/**
 * Single source of truth for the override-vs-defaults decision. Null
 * override → defaults. Non-null override → override verbatim. Used
 * symmetrically by the SW boot path, the chrome.storage.onChanged
 * listener, and the popup-side bgOperatorsGet response shape.
 */
export function mergeOperatorOverride(
  defaults: ReadonlyArray<OperatorEntry>,
  override: OperatorEntry[] | null,
): OperatorEntry[] {
  if (override === null || override.length === 0) {
    return defaults.map((d) => ({ ...d }));
  }
  return override.map((o) => ({ ...o }));
}
