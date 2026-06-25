// Web-accessible-resources hardening (P6-003).
//
// crxjs injects a `web_accessible_resources` block for the content-script
// bundles (provider/bridge) with `use_dynamic_url: false`. A static WAR URL
// (`chrome-extension://<fixed-id>/<fixed-path>`) lets any page fetch-probe it
// to fingerprint that the wallet is installed. `use_dynamic_url: true` makes
// Chrome serve those resources under a per-session rotating URL, removing the
// stable probe target. This is anti-fingerprinting hygiene, not a security
// boundary, so it's applied in BOTH prod and dev builds. Run from the same
// post-bundle plugin as the CSP injection (vite.config.ts), on the emitted
// dist/manifest.json (crxjs writes the WAR block from its own later hook).

/** Flip every `web_accessible_resources[].use_dynamic_url` to `true` in a
 *  manifest JSON string. No-op (returns the input unchanged) when there's no
 *  WAR block or every entry is already `true`. Resources/matches are untouched. */
export function applyDynamicWarUrl(manifestSource: string): string {
  const manifest = JSON.parse(manifestSource) as {
    web_accessible_resources?: Array<{ use_dynamic_url?: boolean }>;
  };
  const war = manifest.web_accessible_resources;
  if (!Array.isArray(war) || war.length === 0) return manifestSource;
  let changed = false;
  for (const entry of war) {
    if (entry.use_dynamic_url !== true) {
      entry.use_dynamic_url = true;
      changed = true;
    }
  }
  return changed ? JSON.stringify(manifest, null, 2) + "\n" : manifestSource;
}
