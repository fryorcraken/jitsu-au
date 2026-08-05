#!/usr/bin/env bun
//
// Screenshot every public page of a production build, at desktop and phone
// widths, so a pull request can be reviewed by looking at it.
//
// Run it with **bun** (not node): the page list is imported straight from
// `src/lib/seo.ts` so a new marketing page is photographed the moment it is
// added to the sitemap, and only bun can import that TypeScript module
// directly.
//
//   bun add --no-save playwright   # CI-only tool, deliberately not in package.json
//   bunx playwright install chromium
//   NITRO_PRESET=node-server bun run build   # a server this can run directly
//   bun scripts/pr-screenshots.mjs
//
// `--no-save` matters: package.json dependencies have to be re-resolved by
// Lovable (CLAUDE.md > Lock file strategy), and this tool is not part of the
// app. Set PR_SCREENSHOTS_CHROMIUM if your machine already has a chromium
// Playwright did not install.
//
// Output lands in `screenshots/`: one PNG per page per viewport, a `summary.md`
// table (embedded in the PR comment by .github/workflows/pr-screenshots.yml),
// and an `index.html` contact sheet so the downloaded artifact opens as one
// scrollable page instead of a folder of files.
//
// Exits non-zero if a page fails to render, which makes this a smoke test of
// every public route as well as a screenshot run.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { PUBLIC_PAGES } from "../src/lib/seo.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Public pages that are deliberately absent from the sitemap (they are
 * server-rendered `noindex`, see src/lib/seo.ts) but are still worth looking at
 * in review: they carry the site's two biggest forms.
 */
const EXTRA_PATHS = ["/waiver", "/auth"];

/**
 * Widths members actually read the site at. The heights are only the initial
 * viewport — every shot is full-page, so a long page produces a tall PNG.
 */
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, isMobile: false },
  { name: "mobile", width: 390, height: 844, isMobile: true },
];

const OUT_DIR = resolve(REPO_ROOT, process.env.PR_SCREENSHOTS_OUT ?? "screenshots");
const SERVER_ENTRY = join(REPO_ROOT, ".output/server/index.mjs");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PR_SCREENSHOTS_PORT ?? 4173);
/** Set to screenshot something already running (a dev server, a deploy). */
const EXTERNAL_BASE_URL = process.env.PR_SCREENSHOTS_BASE_URL;
/** Escape hatch for sandboxes that ship a chromium Playwright didn't install. */
const CHROMIUM_PATH = process.env.PR_SCREENSHOTS_CHROMIUM;

const paths = [...PUBLIC_PAGES.map((page) => page.path), ...EXTRA_PATHS];

/**
 * Give the traced server bundle the tslib files it actually imports.
 *
 * `vite.config.ts` aliases `tslib` to `tslib/tslib.es6.js` (pdf-lib needs it —
 * the comment there explains why). Nitro's dependency tracer follows that alias
 * and copies only that one file into `.output/server/node_modules`, but the
 * bundled `@supabase/functions-js` still imports the package's own
 * `tslib/modules/index.js`, which was never copied. The Cloudflare build we
 * deploy inlines its dependencies so it never sees this; the node-server build
 * this script runs resolves them from disk and 500s on every SSR request.
 *
 * Copying the real package over the traced stub fixes it without touching the
 * alias that the PDF renderer depends on.
 */
function repairTracedTslib() {
  const tracedRoot = join(REPO_ROOT, ".output/server/node_modules/.nf3");
  if (!existsSync(tracedRoot)) return;

  for (const entry of readdirSync(tracedRoot)) {
    if (!entry.startsWith("tslib@")) continue;
    const version = entry.slice("tslib@".length);
    const traced = join(tracedRoot, entry);
    if (existsSync(join(traced, "modules/index.js"))) continue;

    const source = findInstalledPackage("tslib", version);
    if (!source) {
      console.warn(`[screenshots] no installed tslib@${version} to repair ${entry} with`);
      continue;
    }
    cpSyncish(source, traced);
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
    // is enough for the transitive tslib installs bun produces.
    if (root !== join(REPO_ROOT, "node_modules")) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      roots.push(join(root, entry.name, "node_modules"));
    }
  }
  return undefined;
}

/** `cp -R src/. dest/` without pulling in a dependency. */
function cpSyncish(source, dest) {
  return cp(source, dest, { recursive: true, force: true });
}

/** Start the built server and resolve once it answers, or throw with its log. */
async function startServer() {
  if (EXTERNAL_BASE_URL) return { baseUrl: EXTERNAL_BASE_URL, stop: () => {} };

  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `No server build at ${SERVER_ENTRY}. Run \`NITRO_PRESET=node-server bun run build\` first.`,
    );
  }
  await repairTracedTslib();

  const log = [];
  const child = spawn("node", [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOST, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));

  const baseUrl = `http://${HOST}:${PORT}`;
  const stop = () => child.kill("SIGTERM");
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with ${child.exitCode}:\n${log.join("")}`);
    }
    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      // A 500 here is the SSR error page, not a healthy server.
      if (response.status < 500) return { baseUrl, stop };
      throw new Error(`GET / returned ${response.status}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  stop();
  throw new Error(`Server did not come up on ${baseUrl} within 60s:\n${log.join("")}`);
}

/** "/" -> "home", "/manager/kb" -> "manager-kb". */
function slugFor(path) {
  return path === "/" ? "home" : path.replace(/^\//, "").replace(/\//g, "-");
}

async function shoot(browser, baseUrl, viewport, path) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const file = join(OUT_DIR, viewport.name, `${slugFor(path)}.png`);

  try {
    const response = await page.goto(`${baseUrl}${path}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    const status = response?.status() ?? 0;
    // Fonts settle after load; screenshotting before they do swaps the
    // typeface mid-run and makes every diff look like a change.
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled", caret: "hide" });
    return { path, viewport: viewport.name, status, ok: status < 400, file };
  } catch (error) {
    return { path, viewport: viewport.name, status: 0, ok: false, error: String(error) };
  } finally {
    await context.close();
  }
}

function writeSummary(results) {
  const byPath = new Map();
  for (const result of results) {
    if (!byPath.has(result.path)) byPath.set(result.path, {});
    byPath.get(result.path)[result.viewport] = result;
  }

  const rows = [...byPath.entries()].map(([path, shots]) => {
    const states = VIEWPORTS.map((viewport) => {
      const shot = shots[viewport.name];
      if (!shot) return "—";
      return shot.ok ? `${shot.status}` : `❌ ${shot.error ? "error" : shot.status}`;
    });
    return `| \`${path}\` | ${states.join(" | ")} |`;
  });

  const header = `| Page | ${VIEWPORTS.map((v) => `${v.name} (${v.width}px)`).join(" | ")} |`;
  const divider = `| --- | ${VIEWPORTS.map(() => "---").join(" | ")} |`;
  writeFileSync(join(OUT_DIR, "summary.md"), [header, divider, ...rows].join("\n") + "\n");
}

function writeContactSheet(results) {
  const byPath = new Map();
  for (const result of results) {
    if (!byPath.has(result.path)) byPath.set(result.path, {});
    byPath.get(result.path)[result.viewport] = result;
  }

  const sections = [...byPath.entries()]
    .map(([path, shots]) => {
      const figures = VIEWPORTS.map((viewport) => {
        const shot = shots[viewport.name];
        if (!shot?.ok) {
          return `<figure><figcaption>${viewport.name} — failed</figcaption><pre>${escapeHtml(
            shot?.error ?? `HTTP ${shot?.status ?? "?"}`,
          )}</pre></figure>`;
        }
        const src = `${viewport.name}/${slugFor(path)}.png`;
        return `<figure><figcaption>${viewport.name}</figcaption><a href="${src}"><img src="${src}" alt="${escapeHtml(path)} at ${viewport.name} width"></a></figure>`;
      }).join("\n");
      return `<section><h2>${escapeHtml(path)}</h2><div class="shots">${figures}</div></section>`;
    })
    .join("\n");

  writeFileSync(
    join(OUT_DIR, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UTS Jitsu — PR screenshots</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; padding: 2rem 1.5rem 4rem; max-width: 1400px;
         font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 1.4rem; }
  section { margin: 2.5rem 0; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent);
            padding-top: 1rem; }
  h2 { font-size: 1.1rem; font-family: ui-monospace, monospace; }
  .shots { display: flex; gap: 1.5rem; align-items: flex-start; flex-wrap: wrap; }
  figure { margin: 0; flex: 1 1 320px; min-width: 280px; }
  figure:last-child { flex: 0 1 390px; }
  figcaption { font-size: 0.8rem; opacity: 0.7; margin-bottom: 0.4rem; }
  img { width: 100%; height: auto; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
        border-radius: 6px; }
  pre { white-space: pre-wrap; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>UTS Jitsu — public pages on this branch</h1>
<p>Full-page screenshots of the production build. Click an image for the original.</p>
${sections}
</body>
</html>
`,
  );
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

rmSync(OUT_DIR, { recursive: true, force: true });
for (const viewport of VIEWPORTS) mkdirSync(join(OUT_DIR, viewport.name), { recursive: true });

const server = await startServer();

const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH || undefined,
});

const results = [];
try {
  for (const viewport of VIEWPORTS) {
    for (const path of paths) {
      const result = await shoot(browser, server.baseUrl, viewport, path);
      results.push(result);
      console.log(
        `[screenshots] ${viewport.name.padEnd(7)} ${path.padEnd(20)} ${result.ok ? `ok (${result.status})` : `FAILED ${result.error ?? result.status}`}`,
      );
    }
  }
} finally {
  await browser.close();
  server.stop();
}

writeSummary(results);
writeContactSheet(results);

const failed = results.filter((result) => !result.ok);
console.log(`[screenshots] ${results.length - failed.length}/${results.length} pages captured`);
if (failed.length > 0) {
  console.error(`[screenshots] ${failed.length} page(s) failed to render`);
  process.exit(1);
}
