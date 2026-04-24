import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
