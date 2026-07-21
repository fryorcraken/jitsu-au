import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Standalone test config. We intentionally do NOT reuse vite.config.ts: that file
// is wrapped by @lovable.dev/vite-tanstack-config, which injects the TanStack
// Start / Nitro SSR plugins and sandbox detection — none of which should run under
// the test runner. Here we only need React + jsdom + the "@/" path alias.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
