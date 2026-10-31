import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // Build output and generated code (shadcn primitives, Supabase types, the
    // router tree) are not hand-maintained, so they are exempt from lint. The
    // one hand-written test under components/ui still runs under Vitest.
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      "src/components/ui/**",
      "src/integrations/supabase/types.ts",
      // Lovable writes this one ("automatically generated. Do not edit it
      // directly.") and rewrites it on sync, so a hand fix would not survive.
      "src/integrations/supabase/previewAuthStorage.ts",
      "src/routeTree.gen.ts",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Spelled out rather than spread from `reactHooks.configs.recommended`:
      // from v6 that preset also turns on the React Compiler rules, which
      // flag dozens of working components. Adopting them is a refactor of its
      // own, not part of a version bump.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      // TanStack Start 1.169 removes `.inputValidator()` with no alias. On the
      // 1.168 line it still type-checks (it is only deprecated) and the build
      // does not type-check at all, so lint is the one check that refuses it
      // before the upgrade turns it into a broken server function.
      "no-restricted-properties": [
        "error",
        {
          property: "inputValidator",
          message:
            "Use `.validator()`. `.inputValidator()` is deprecated in TanStack Start 1.168 and gone in 1.169.",
        },
      ],
      // A route file exports `Route = createFileRoute(...)(...)` with its page
      // components beside it, TanStack Router's convention. Naming the route
      // builders here lets the rule count that export as a component, as it
      // did before v0.5, so it stays quiet about the convention and still
      // flags anything else a route file exports.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true, extraHOCs: ["createFileRoute", "createRootRouteWithContext"] },
      ],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  eslintPluginPrettier,
);
