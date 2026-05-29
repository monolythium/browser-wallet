// Wallet-version update check vs the Chrome Web Store.
//
// Mirrors the About SDK-latest cache + honest-absence pattern. Uses the
// official `chrome.runtime.requestUpdateCheck()` — it compares the installed
// version against the CWS-published one with no scraping / CORS / extra
// permission. Caveats handled as honest-absence (no banner): in dev/unpacked
// the API throws / isn't meaningful, and Chrome throttles repeat calls.
//
// Pure helpers (cache gate, status fold, parse) live here and are unit-tested;
// the chrome.runtime call + chrome.storage round-trip are orchestrated by the
// popup (App) on open.

export const CWS_LISTING_URL =
  "https://chromewebstore.google.com/detail/monolythium-browser-walle/hendlkmpghhmhmggjebkpbedncpepkgj";

/** Check at most ~2×/day. */
export const WALLET_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export const STORAGE_KEY_WALLET_UPDATE = "mono.wallet-update.v1";

export interface WalletUpdateCache {
  /** Epoch ms of the last completed check. */
  lastCheckAt: number;
  /** Last known "an update is available" verdict. */
  updateAvailable: boolean;
}

export type WalletUpdateStatus =
  | "update_available"
  | "no_update"
  | "throttled"
  | "unavailable";

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

/** Pure: tolerant parse of the stored cache (malformed → null). */
export function parseWalletUpdateCache(raw: unknown): WalletUpdateCache | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as { lastCheckAt?: unknown; updateAvailable?: unknown };
  if (typeof r.lastCheckAt !== "number" || !Number.isFinite(r.lastCheckAt)) {
    return null;
  }
  if (typeof r.updateAvailable !== "boolean") return null;
  return { lastCheckAt: r.lastCheckAt, updateAvailable: r.updateAvailable };
}

/** Promisified `chrome.runtime.requestUpdateCheck`. Returns "unavailable" when
 *  the API is absent (non-Chrome) or throws (dev/unpacked builds). */
export async function requestWalletUpdateStatus(): Promise<WalletUpdateStatus> {
  try {
    if (
      typeof chrome === "undefined" ||
      typeof chrome.runtime?.requestUpdateCheck !== "function"
    ) {
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
