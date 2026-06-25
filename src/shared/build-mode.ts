// Single source of truth for "is this a hardened (production) build?".
//
// In a hardened build the strict `connect-src` allowlist is active (generated
// by src/build/csp.ts and injected into the manifest by vite.config.ts —
// production only). Under that allowlist the wallet can dial ONLY the
// allowlisted built-in fleet, so custom chains and a stored operator override
// are NOT dialable (their hosts aren't in the allowlist → CSP-blocked → every
// RPC would fail → bricked). The background dial-set must therefore narrow to
// exactly the allowlisted set in a hardened build (see hardened-dial.ts).
//
// Dev/test builds ship NO CSP (so crxjs HMR + custom RPC/chains keep working),
// and this returns false there — the wallet behaves exactly as before.
export function isHardenedBuild(): boolean {
  return import.meta.env.PROD === true;
}
