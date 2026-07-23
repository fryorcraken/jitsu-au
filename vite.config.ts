// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    resolve: {
      alias: {
        // tslib 1.x (a transitive dep of pdf-lib) ships a CJS entry (tslib.js)
        // that sets `__esModule = true`, and an ESM shim (tslib/modules/index.js,
        // the package's "import" condition) that default-imports that CJS entry
        // and destructures the helpers off it: `import tslib from "../tslib.js";
        // const { __extends } = tslib`. Under esbuild's strict interop (Vite
        // dev/SSR) a CJS module flagged `__esModule` has NO synthesized default,
        // so `tslib` is undefined and the destructure throws
        // "Cannot destructure property '__extends' of __toESM(...).default".
        // pdf-lib's ESM build does `import { __extends } from "tslib"`, so signing
        // a waiver (which renders the PDF) crashes in the dev/preview server.
        // Rollup (the production build) synthesizes the default correctly, which
        // is why only the preview breaks. Point tslib straight at its real ESM
        // module, which `export`s every helper by name and needs no interop.
        tslib: "tslib/tslib.es6.js",
      },
    },
  },
});
