import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2022",
    sourcemap: true,
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
});
