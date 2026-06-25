// Strict `connect-src` allowlist generator (P6-001).
//
// Generated at build time from the SAME source the runtime dials —
// getRpcEndpoints("testnet-69420") (see networks.ts + hardened-dial.ts) — so
// the allowlist and the dial-set cannot diverge (the coupling invariant). The
// committed manifest.json stays CSP-free; vite.config.ts injects this into the
// emitted dist/manifest.json for PRODUCTION builds only. When O1 lands
// (operators move to https domains) the next build emits https/wss
// automatically — no hand-maintained IP list.

/** The minimal shape read from an SDK RpcEndpoint (kept structural so this
 *  module doesn't depend on the SDK's exported type). */
export interface EndpointLike {
  url: string;
  ws_url?: string;
}

/** Hosts the wallet legitimately reaches at runtime besides the fleet:
 *  the About page's SDK update check + live registry-genesis read. */
const STATIC_HOSTS = [
  "https://registry.npmjs.org", // sdk-latest.ts
  "https://raw.githubusercontent.com", // live-registry.ts (via the SDK)
] as const;

/** WS origin for an endpoint, mirroring ws-client.ts `deriveWsUrl`: an explicit
 *  `ws_url` wins; else port 8545 → 8546; scheme http→ws, https→wss. */
function wsOrigin(ep: EndpointLike): string {
  if (ep.ws_url !== undefined && ep.ws_url.length > 0) {
    return new URL(ep.ws_url).origin;
  }
  const u = new URL(ep.url);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  const port = u.port === "8545" ? "8546" : u.port;
  return `${proto}//${u.hostname}${port ? `:${port}` : ""}`;
}

/** The full `extension_pages` directive for a hardened (production) build:
 *  `script-src`/`object-src` re-state the MV3 default (no-op); `connect-src`
 *  is the strict allowlist (fleet RPC + WS + the two static hosts + 'self'). */
export function buildExtensionCsp(endpoints: readonly EndpointLike[]): string {
  const connect = new Set<string>(["'self'"]);
  for (const ep of endpoints) {
    connect.add(new URL(ep.url).origin); // http://<ip>:8545
    connect.add(wsOrigin(ep)); // ws://<ip>:8546
  }
  for (const host of STATIC_HOSTS) connect.add(host);
  return [
    "script-src 'self'",
    "object-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
  ].join("; ");
}

/** Inject the hardened CSP into a manifest JSON string. PRODUCTION ONLY — in a
 *  dev build the source is returned unchanged (no CSP, so crxjs HMR + custom
 *  RPC/chains keep working). Used by the vite.config post-bundle plugin. */
export function applyHardenedCsp(
  manifestSource: string,
  endpoints: readonly EndpointLike[],
  isProduction: boolean,
): string {
  if (!isProduction) return manifestSource;
  const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
  const existing = (manifest.content_security_policy ?? {}) as Record<
    string,
    string
  >;
  manifest.content_security_policy = {
    ...existing,
    extension_pages: buildExtensionCsp(endpoints),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}
