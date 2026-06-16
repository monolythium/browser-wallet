// Wallet-version update check vs the Chrome Web Store.
//
// Mirrors the About SDK-latest cache + honest-absence pattern. Uses the
// official `chrome.runtime.requestUpdateCheck()` — it compares the installed
// version against the CWS-published one with no scraping / CORS / extra
// permission. Caveats handled as honest-absence: a dev/unpacked/sideloaded
// build (runtime id != the published CWS id) can't meaningfully run the check
// and Chrome would just throttle it, so we skip the call there and report
// "unavailable"; "throttled" is reserved for the real Web Store build being
// rate-limited.
//
// Pure helpers (cache gate, status fold, parse) live here and are unit-tested;
// the chrome.runtime call + chrome.storage round-trip are orchestrated by the
// popup (App) on open.

export const CWS_LISTING_URL =
  "https://chromewebstore.google.com/detail/monolythium-browser-walle/hendlkmpghhmhmggjebkpbedncpepkgj";

/** Extension id of the PUBLISHED Chrome Web Store build. A dev/unpacked or
 *  sideloaded load has a different runtime id; `requestUpdateCheck` can't
 *  meaningfully run there (Chrome throttles/declines it), so we skip the call
 *  and report "unavailable" instead of the confusing "throttled". */
export const CWS_EXTENSION_ID = "hendlkmpghhmhmggjebkpbedncpepkgj";

/** Check at most ~2×/day. */
export const WALLET_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export const STORAGE_KEY_WALLET_UPDATE = "mono.wallet-update.v1";

export type WalletUpdateStatus =
  | "update_available"
  | "no_update"
  | "throttled"
  | "unavailable";

export interface WalletUpdateCache {
  /** Epoch ms of the last completed check. */
  lastCheckAt: number;
  /** Last known "an update is available" verdict. */
  updateAvailable: boolean;
  /** Raw status of the last check — surfaced on About. Optional for backward
   *  compatibility with caches written before this field existed. */
  lastStatus?: WalletUpdateStatus;
}

/** Pure: run a fresh check only when the cache is older than the interval
 *  (or absent). */
export function shouldCheckWalletUpdate(
  lastCheckAt: number | null,
  now: number,
): boolean {
  if (lastCheckAt === null) return true;
  return now - lastCheckAt >= WALLET_UPDATE_CHECK_INTERVAL_MS;
}

/** Pure: fold a check status into the next `updateAvailable`, given the prior
 *  value. A definite answer flips it; "throttled" / "unavailable" keep the
 *  prior (honest-absence — never invent a verdict on a non-answer). */
export function nextUpdateAvailable(
  status: WalletUpdateStatus,
  prior: boolean,
): boolean {
  switch (status) {
    case "update_available":
      return true;
    case "no_update":
      return false;
    default:
      return prior;
  }
}

function asWalletUpdateStatus(v: unknown): WalletUpdateStatus | undefined {
  return v === "update_available" ||
    v === "no_update" ||
    v === "throttled" ||
    v === "unavailable"
    ? v
    : undefined;
}

/** Pure: tolerant parse of the stored cache (malformed → null). */
export function parseWalletUpdateCache(raw: unknown): WalletUpdateCache | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as {
    lastCheckAt?: unknown;
    updateAvailable?: unknown;
    lastStatus?: unknown;
  };
  if (typeof r.lastCheckAt !== "number" || !Number.isFinite(r.lastCheckAt)) {
    return null;
  }
  if (typeof r.updateAvailable !== "boolean") return null;
  const lastStatus = asWalletUpdateStatus(r.lastStatus);
  return {
    lastCheckAt: r.lastCheckAt,
    updateAvailable: r.updateAvailable,
    ...(lastStatus ? { lastStatus } : {}),
  };
}

/** Promisified `chrome.runtime.requestUpdateCheck`. Returns "unavailable"
 *  WITHOUT calling the API when it's absent (non-Chrome) or this isn't the
 *  published Web Store build (dev/unpacked/sideloaded id) — there the check
 *  can't run and Chrome would just throttle it. Otherwise maps the real
 *  status, returning "unavailable" on any throw. */
export async function requestWalletUpdateStatus(): Promise<WalletUpdateStatus> {
  try {
    if (
      typeof chrome === "undefined" ||
      typeof chrome.runtime?.requestUpdateCheck !== "function"
    ) {
      return "unavailable";
    }
    if (
      typeof chrome.runtime.id === "string" &&
      chrome.runtime.id !== CWS_EXTENSION_ID
    ) {
      // Dev/unpacked/sideloaded build — don't call (avoids the throttle) and
      // report honestly that the check can't run here.
      return "unavailable";
    }
    const result = await chrome.runtime.requestUpdateCheck();
    const status = result?.status;
    if (status === "update_available") return "update_available";
    if (status === "throttled") return "throttled";
    if (status === "no_update") return "no_update";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Clear the persisted wallet-update verdict after an applied update (or fresh
 *  install), driven by `chrome.runtime.onInstalled`. Once an update is applied
 *  the running version IS the new version, so any prior "update available"
 *  verdict in {@link STORAGE_KEY_WALLET_UPDATE} is stale by construction.
 *  Removing it makes the next popup open re-derive cleanly (the fresh-install
 *  path), instead of the banner persisting behind the 12h check gate +
 *  `throttled`/`unavailable` stickiness. No-op for other reasons or when
 *  `chrome.storage` is unavailable. */
export async function reconcileWalletUpdateOnInstalled(
  reason: string,
): Promise<void> {
  if (reason !== "update" && reason !== "install") return;
  if (
    typeof chrome === "undefined" ||
    typeof chrome.storage?.local?.remove !== "function"
  ) {
    return;
  }
  await chrome.storage.local.remove(STORAGE_KEY_WALLET_UPDATE);
}
