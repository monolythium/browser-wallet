// Best-effort lookup of the latest published @monolythium/core-sdk release,
// used by the About page to compare against the installed version.
//
// Source: the public npm registry's per-package "latest" dist-tag endpoint,
// which returns the latest version manifest and (verified) sends
// `Access-Control-Allow-Origin: *`, so the extension popup can fetch it
// without a host permission (same posture as the GitHub chain-registry
// fetch). This is a RUNTIME read — it reflects what's published right now,
// which is what makes the "update available" hint meaningful. Every failure
// mode (offline, CORS, rate-limit, malformed body) resolves to null and the
// caller shows installed-only — never a fabricated number.

const NPM_LATEST_URL =
  "https://registry.npmjs.org/@monolythium/core-sdk/latest";

/** Fetch the latest published SDK version, or null on any failure. */
export async function fetchLatestSdkVersion(
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(NPM_LATEST_URL, signal ? { signal } : undefined);
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0
      ? body.version
      : null;
  } catch {
    return null;
  }
}

/** Compare two dotted version strings by numeric major.minor.patch core
 *  (pre-release / build metadata ignored). Returns 1 if `a` is newer than
 *  `b`, -1 if older, 0 if equal or unparseable. */
export function compareSemver(a: string, b: string): number {
  const core = (v: string) =>
    v.split(".").slice(0, 3).map((p) => parseInt(p, 10));
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
