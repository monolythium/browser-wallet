// Popup-only invariant assertion (DA-013).
//
// The service worker admits popup-internal ops only from a sender whose URL
// starts with `chrome.runtime.getURL("src/popup/")` (service-worker.ts, the
// `m?.kind === "popup"` branch). That prefix check is what keeps every popup op
// — keystore unlock, seed export, vault removal — off-limits to a web page and
// to a compromised content script.
//
// The check is a boundary only while NO extension HTML is web-accessible. If a
// page under this extension's origin were listed in `web_accessible_resources`,
// any site could embed it in a frame; messages from that frame carry a
// `sender.url` on the extension origin, and a path-prefix test cannot separate
// such a frame from the real popup document.
//
// Today the invariant holds because `src/popup/index.html` is the only HTML in
// the tree and crxjs lists only the two content-script bundles as web-accessible
// — an observation about the file tree, not a gate. This module is the gate: it
// runs from the post-bundle plugin in vite.config.ts against the EMITTED
// dist/manifest.json, so it sees what actually ships.
//
// Scope, stated plainly because a half-understood gate is worse than none:
//   - It inspects the manifest's DECLARED web_accessible_resources. A plugin
//     whose writeBundle runs after ours could still edit the file afterwards.
//   - It does not read the emitted files. An HTML file sitting in dist/ that
//     nothing makes web-accessible is correctly not flagged — it is unreachable
//     from a page.
//   - It does not constrain extension pages that are NOT web-accessible (an
//     options page, the side panel). Those are reachable only by the user or by
//     this extension, which is the same trust level the popup already has.
//   - It is a build-time check. It cannot see a manifest edited after packaging.

/** One web-accessible resource that would void the popup-op gate. */
export interface EmbeddablePageViolation {
  /** Index into `web_accessible_resources` — the block the resource came from. */
  entryIndex: number;
  /** The resource pattern exactly as it appears in the manifest. */
  resource: string;
  /** Why this resource breaks the invariant, in prose fit for a build error. */
  reason: string;
}

/** The path prefix the service worker's popup-op gate tests against. Keep in
 *  step with the `getURL("src/popup/")` call in service-worker.ts. */
const POPUP_SOURCE_PREFIX = "src/popup/";

/** Concrete paths a wildcard must not be able to reach. The popup document is
 *  the one that voids the gate outright; the other two catch a wildcard that
 *  opens up HTML generally, which would void it as soon as any page is added. */
const EMBEDDABLE_PROBES = [
  "src/popup/index.html",
  "index.html",
  "pages/anything.html",
] as const;

/** Chrome matches WAR patterns with `*` as a multi-segment wildcard. Translate
 *  to a RegExp so a pattern can be tested against the probe paths rather than
 *  guessed at by inspecting the string. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Why `resource` breaks the invariant, or null if it is fine. */
function violationReason(resource: string): string | null {
  // A WAR pattern carries no query in practice, but the popup is addressed as
  // `index.html?surface=sidepanel` elsewhere in this codebase, so classify on
  // the path alone rather than letting a query hide the extension.
  const path = resource.split(/[?#]/)[0] ?? resource;
  if (path.startsWith(POPUP_SOURCE_PREFIX)) {
    return `it is under the popup source path "${POPUP_SOURCE_PREFIX}", which is exactly what the popup-op gate treats as trusted`;
  }
  if (/\.html?$/i.test(path)) {
    return "it is an HTML document, and any web-accessible extension page can be framed by an arbitrary site";
  }
  if (path.includes("*")) {
    const re = globToRegExp(path);
    const reached = EMBEDDABLE_PROBES.find((probe) => re.test(probe));
    if (reached !== undefined) {
      return `it is a wildcard that matches "${reached}", so it can expose an extension page`;
    }
  }
  return null;
}

/** Every web-accessible resource in `manifestSource` that would let a web page
 *  obtain a `sender.url` the popup-op gate accepts. Empty means the invariant
 *  holds for this manifest. */
export function findEmbeddablePageResources(
  manifestSource: string,
): EmbeddablePageViolation[] {
  const manifest = JSON.parse(manifestSource) as {
    web_accessible_resources?: Array<{ resources?: unknown }>;
  };
  const war = manifest.web_accessible_resources;
  if (!Array.isArray(war)) return [];
  const out: EmbeddablePageViolation[] = [];
  war.forEach((entry, entryIndex) => {
    const resources = entry?.resources;
    if (!Array.isArray(resources)) return;
    for (const resource of resources) {
      if (typeof resource !== "string") continue;
      const reason = violationReason(resource);
      if (reason !== null) out.push({ entryIndex, resource, reason });
    }
  });
  return out;
}

/** Fail the build if the packaged extension would expose an embeddable page.
 *  The message names every offender and the mechanism it voids — a build that
 *  breaks here should not need a code read to understand why. */
export function assertPopupOnlyInvariant(manifestSource: string): void {
  const violations = findEmbeddablePageResources(manifestSource);
  if (violations.length === 0) return;
  const found = violations.map(
    (v) =>
      `  - web_accessible_resources[${v.entryIndex}] "${v.resource}"\n      ${v.reason}`,
  );
  throw new Error(
    [
      "Popup-only invariant broken — the packaged extension would expose an embeddable page.",
      "",
      "Found:",
      ...found,
      "",
      "Why this fails the build: the service worker admits popup ops only when",
      `\`sender.url\` starts with getURL("${POPUP_SOURCE_PREFIX}"). A web-accessible extension`,
      "page can be framed by any site, and messages from that frame carry a sender.url on",
      "the extension origin — so a path prefix can no longer tell that frame apart from the",
      "real popup, and every popup op (unlock, seed export, vault removal) becomes reachable.",
      "",
      "If this resource genuinely must ship, the popup-op gate needs a stronger check than a",
      "path prefix before it can — change the gate first, not this assertion.",
    ].join("\n"),
  );
}
