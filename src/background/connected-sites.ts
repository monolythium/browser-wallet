// Monolythium Wallet — connected-origins persistence.
//
// `eth_requestAccounts` records the user's approval per origin so subsequent
// `eth_accounts` calls and silent re-connects don't re-prompt. The SW holds an
// in-memory `connectedOrigins: Set<string>` for fast checks; this module is
// the storage half so the set survives MV3 service-worker hibernation.
//
// Schema: { [origin]: { address, approvedAt } } — value-shaped (not just a
// Set<origin>) so a future multi-account / per-site account selection can
// extend the value without migrating the storage key.

const CONNECTED_SITES_STORAGE_KEY = "mono.connected-sites";

export interface ConnectedSiteRecord {
  address: string;
  approvedAt: number;
}

export type ConnectedSitesMap = Record<string, ConnectedSiteRecord>;

export async function loadConnectedSites(): Promise<ConnectedSitesMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONNECTED_SITES_STORAGE_KEY, (got) => {
      const raw = got?.[CONNECTED_SITES_STORAGE_KEY];
      if (!raw || typeof raw !== "object") {
        resolve({});
        return;
      }
      // Trust-but-verify the shape: drop any entry that doesn't match. Storage
      // is local-only but a corrupt write (older code path, manual edit) should
      // not crash the SW boot.
      const out: ConnectedSitesMap = {};
      for (const [origin, rec] of Object.entries(raw as Record<string, unknown>)) {
        if (
          rec &&
          typeof rec === "object" &&
          typeof (rec as ConnectedSiteRecord).address === "string" &&
          typeof (rec as ConnectedSiteRecord).approvedAt === "number"
        ) {
          out[origin] = rec as ConnectedSiteRecord;
        }
      }
      resolve(out);
    });
  });
}

export async function saveConnectedSite(
  origin: string,
  address: string,
): Promise<void> {
  const sites = await loadConnectedSites();
  sites[origin] = { address, approvedAt: Date.now() };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CONNECTED_SITES_STORAGE_KEY]: sites }, () =>
      resolve(),
    );
  });
}

export async function removeConnectedSite(origin: string): Promise<void> {
  const sites = await loadConnectedSites();
  if (!(origin in sites)) return;
  delete sites[origin];
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CONNECTED_SITES_STORAGE_KEY]: sites }, () =>
      resolve(),
    );
  });
}

export async function listConnectedOrigins(): Promise<string[]> {
  const sites = await loadConnectedSites();
  return Object.keys(sites);
}
