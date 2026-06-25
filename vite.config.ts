import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { getRpcEndpoints } from "@monolythium/core-sdk";
import manifest from "./manifest.json" with { type: "json" };
import { applyHardenedCsp } from "./src/buildtime/csp";
import { applyDynamicWarUrl } from "./src/buildtime/manifest-war";

// Read the ACTUALLY-INSTALLED @monolythium/core-sdk version at build time and
// inject it into the bundle (the About page reads it via __SDK_INSTALLED_VERSION__).
// Read the file directly — the SDK's package `exports` doesn't expose
// ./package.json, so a bare require/import of it would be blocked.
function readInstalledSdkVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        new URL(
          "./node_modules/@monolythium/core-sdk/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Post-bundle manifest hardening (edits the emitted dist/manifest.json):
 *  - P6-001: inject the strict `connect-src` allowlist (from the SDK fleet),
 *    PRODUCTION ONLY (dev leaves the CSP unset so crxjs HMR + custom RPC/chains
 *    keep working, and the committed manifest.json stays CSP-free).
 *  - P6-003: flip `web_accessible_resources[].use_dynamic_url` to true
 *    (anti-fingerprinting), in BOTH prod and dev.
 *
 * crxjs emits manifest.json from its own (later) generateBundle, so it isn't in
 * the bundle when an ordinary post-plugin's generateBundle runs — hook
 * writeBundle and edit the file on disk, after Rollup has written it.
 */
function hardenedManifestPlugin(mode: string): Plugin {
  return {
    name: "mono-hardened-manifest",
    enforce: "post",
    writeBundle(options) {
      const file = join(options.dir ?? "dist", "manifest.json");
      const src = readFileSync(file, "utf8");
      let out = applyDynamicWarUrl(src); // always (hygiene, not a boundary)
      out = applyHardenedCsp(
        out,
        getRpcEndpoints("testnet-69420"),
        mode === "production", // prod-only
      );
      if (out !== src) writeFileSync(file, out);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest }), hardenedManifestPlugin(mode)],
  define: {
    __SDK_INSTALLED_VERSION__: JSON.stringify(readInstalledSdkVersion()),
  },
  build: {
    target: "es2022",
    // T1-02 — do NOT ship source maps in the published (production) extension:
    // they un-minify the SW/keystore logic for anyone who downloads the .crx.
    // Dev/test builds keep maps for debuggability. `pnpm build` runs with the
    // default "production" mode, so the shipped artifact carries no .map files.
    sourcemap: mode !== "production",
    // Round 4 TASK 7 — split heavy vendor groups into their own
    // chunks so the popup bundle (which used to land at ~714 kB)
    // stops tripping rollup's 500 kB warning. Browser extensions
    // don't gain page-load wins from chunk splitting the way web
    // apps do, but smaller per-vendor bundles improve cross-build
    // cache reuse and make the size budget legible.
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-sdk": ["@monolythium/core-sdk"],
          // @noble/* deliberately NOT split — rollup tree-shakes them
          // into the SW (which is the only consumer of keystore-mldsa.ts
          // and the actual user of post-quantum/ciphers/hashes) and a
          // dedicated chunk lands empty. Keeping noble co-located with
          // the SW chunk avoids the rollup "empty chunk" warning.
        },
      },
    },
    // Extension bundles routinely exceed the web-default 500 kB, and
    // the manualChunks split above brings the popup chunk under
    // 500 kB on its own. 1000 kB sets a reasonable ceiling for the
    // remaining vendor groups (the SDK chunk is ~215 kB; nobles are
    // smaller still) without silencing warnings for any realistic
    // accidental bloat.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
}));
