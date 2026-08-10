#!/usr/bin/env bun
//
// Give a `NITRO_PRESET=node-server` build the tslib files it actually imports.
//
// `vite.config.ts` aliases `tslib` to `tslib/tslib.es6.js` (pdf-lib needs it —
// the comment there explains why). Nitro's dependency tracer follows that alias
// and copies only that one file into `.output/server/node_modules`, but the
// bundled `@supabase/functions-js` still imports the package's own
// `tslib/modules/index.js`, which was never copied. The Cloudflare build we
// deploy inlines its dependencies so it never sees this; a node-server build
// resolves them from disk and 500s on every SSR request.
//
// Copying the real package over the traced stub fixes it without touching the
// alias that the PDF renderer depends on.
//
// Both things that run a node-server build locally need this — the PR
// screenshots and the end-to-end tests — which is why it lives here rather than
// in either of them. Run it directly (`bun scripts/repair-traced-tslib.mjs`)
// after a build, or import `repairTracedTslib`.

import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function repairTracedTslib() {
  const tracedRoot = join(REPO_ROOT, ".output/server/node_modules/.nf3");
  if (!existsSync(tracedRoot)) return;

  for (const entry of readdirSync(tracedRoot)) {
    if (!entry.startsWith("tslib@")) continue;
    const version = entry.slice("tslib@".length);
    const traced = join(tracedRoot, entry);

    // Copy unconditionally rather than probing for one known-missing file:
    // the version matches exactly, so overwriting the traced stub with the
    // real package cannot change what the server runs, and a stub missing
    // some *other* file would slip past a targeted check.
    const source = findInstalledPackage("tslib", version);
    if (!source) {
      console.warn(`[repair-tslib] no installed tslib@${version} to repair ${entry} with`);
      continue;
    }
    // Synchronous on purpose: callers spawn the server the moment this
    // returns, and an unawaited copy would race the first SSR request.
    cpSync(source, traced, { recursive: true, force: true });
  }
}

/** Locate an installed copy of `name` at exactly `version`, hoisted or nested. */
function findInstalledPackage(name, version) {
  const roots = [join(REPO_ROOT, "node_modules")];

  while (roots.length > 0) {
    const root = roots.shift();
    if (!existsSync(root)) continue;

    const candidate = join(root, name, "package.json");
    if (existsSync(candidate)) {
      try {
        if (JSON.parse(readFileSync(candidate, "utf8")).version === version) {
          return join(root, name);
        }
      } catch {
        // Unreadable package.json: not the copy we want.
      }
    }

    // Nested copies live under <root>/<pkg>/node_modules; one level of fan-out
    // is enough for the transitive tslib installs bun produces. A scope
    // directory holds no package of its own, so descend through it — otherwise
    // a copy nested under @scope/pkg is invisible.
    if (root !== join(REPO_ROOT, "node_modules")) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!entry.name.startsWith("@")) {
        roots.push(join(root, entry.name, "node_modules"));
        continue;
      }
      for (const scoped of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue;
        roots.push(join(root, entry.name, scoped.name, "node_modules"));
      }
    }
  }
  return undefined;
}

// Run as a script (`bun scripts/repair-traced-tslib.mjs`) rather than imported.
// Compared against argv rather than `import.meta.main`, which node only grew
// recently and which this file has to behave the same under.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repairTracedTslib();
}
