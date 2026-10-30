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
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // ESLint 10's recommended set asks every rethrow to carry `{ cause: e }`.
    // Not where server code lives: a server function's error is serialized to
    // the browser with all of its own properties, `cause` included, so
    // following the rule would ship the raw upstream error a rethrow exists to
    // replace with words a person can act on. Log the original server side
    // instead. Everywhere else (components, hooks, scripts) the rule stands.
    files: ["src/lib/**/*.{ts,tsx}", "src/routes/**/*.{ts,tsx}"],
    rules: {
      "preserve-caught-error": "off",
    },
  },
  {
    // A route file exports only `Route` and keeps its page components beside
    // it, which is TanStack Router's file convention. From v0.5 this rule
    // flags every such component; hot reload for them is the router plugin's
    // job (it splits the components out), not something this rule can judge.
    files: ["src/routes/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  eslintPluginPrettier,
);
