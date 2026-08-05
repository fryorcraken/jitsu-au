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
// Exits non-zero if a page fails to render — an error status, or the app's own
// error/404 boundary claiming the page (see isShotOk in pr-screenshots-report).
// That catches a route that blew up, NOT a route that caught its own loader
// error and rendered a card in place of its content, as /blog does.

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { PUBLIC_PAGES } from "../src/lib/seo.ts";
import {
  buildContactSheet,
  buildSummaryTable,
  failureReason,
  isShotOk,
  slugFor,
} from "./pr-screenshots-report.mjs";

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

    // Copy unconditionally rather than probing for one known-missing file:
    // the version matches exactly, so overwriting the traced stub with the
    // real package cannot change what the server runs, and a stub missing
    // some *other* file would slip past a targeted check.
    const source = findInstalledPackage("tslib", version);
    if (!source) {
      console.warn(`[screenshots] no installed tslib@${version} to repair ${entry} with`);
      continue;
    }
    // Synchronous on purpose: the server is spawned the moment this returns,
    // and an unawaited copy would race the first SSR request that needs it.
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

/** Start the built server and resolve once it answers, or throw with its log. */
async function startServer() {
  if (EXTERNAL_BASE_URL) return { baseUrl: EXTERNAL_BASE_URL, stop: () => {} };

  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `No server build at ${SERVER_ENTRY}. Run \`NITRO_PRESET=node-server bun run build\` first.`,
    );
  }
  repairTracedTslib();

  // Something already on the port would answer the health check below within a
  // millisecond, while the child we just spawned takes hundreds to bind, fail
  // with EADDRINUSE and set exitCode. The run would then quietly photograph a
  // previous build. Refuse rather than guess whose server it is.
  if (await isPortAnswering()) {
    throw new Error(
      `Something is already serving http://${HOST}:${PORT}. Stop it, or set PR_SCREENSHOTS_PORT.`,
    );
  }

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
  // Kept so the timeout can say what kept failing. A server that boots and
  // then 500s every request — the tslib breakage this script repairs — is the
  // likeliest failure here, and "did not come up" alone would misname it.
  let lastReason = "no response yet";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with ${child.exitCode}:\n${log.join("")}`);
    }
    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      // A 500 here is the SSR error page, not a healthy server.
      if (response.status < 500) return { baseUrl, stop };
      lastReason = `GET / returned ${response.status}`;
    } catch (error) {
      lastReason = String(error);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(
    `Server did not answer on ${baseUrl} within 60s (last attempt: ${lastReason}):\n${log.join("")}`,
  );
}

/** True if anything at all is already serving the port we are about to take. */
async function isPortAnswering() {
  try {
    await fetch(`http://${HOST}:${PORT}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    return true;
  } catch {
    return false;
  }
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

    // A page that failed still answers 200: both the router's error boundary
    // and its 404 render inside a normal response (src/routes/__root.tsx), so
    // the status code alone would call a site-wide "This page didn't load" a
    // clean run. The boundaries carry data-page-state for exactly this.
    const state = await page.evaluate(
      () => document.querySelector("[data-page-state]")?.getAttribute("data-page-state") ?? null,
    );

    return { path, viewport: viewport.name, status, state, file };
  } catch (error) {
    return { path, viewport: viewport.name, status: 0, state: null, error: String(error) };
  } finally {
    await context.close();
  }
}

function writeSummary(results) {
  writeFileSync(join(OUT_DIR, "summary.md"), buildSummaryTable(results, VIEWPORTS));
}

function writeContactSheet(results) {
  writeFileSync(join(OUT_DIR, "index.html"), buildContactSheet(results, VIEWPORTS));
}

// `PR_SCREENSHOTS_OUT` is wiped before every run, so refuse anything that is
// not a fresh directory below the repo: an absolute path, `.`, or `src` would
// delete working files instead.
if (OUT_DIR === REPO_ROOT || !OUT_DIR.startsWith(REPO_ROOT + sep)) {
  console.error(
    `[screenshots] refusing to empty ${OUT_DIR}: PR_SCREENSHOTS_OUT must name a directory below ${REPO_ROOT}`,
  );
  process.exit(1);
}
rmSync(OUT_DIR, { recursive: true, force: true });
for (const viewport of VIEWPORTS) mkdirSync(join(OUT_DIR, viewport.name), { recursive: true });

const results = [];
let server;
let browser;

try {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROMIUM_PATH || undefined });

  for (const viewport of VIEWPORTS) {
    for (const path of paths) {
      const result = await shoot(browser, server.baseUrl, viewport, path);
      results.push(result);
      console.log(
        `[screenshots] ${viewport.name.padEnd(7)} ${path.padEnd(20)} ${
          isShotOk(result) ? `ok (${result.status})` : `FAILED ${failureReason(result)}`
        }`,
      );
    }
  }
} finally {
  // Both are set one at a time and either can throw, so tear down whatever
  // exists rather than assuming a complete startup.
  await browser?.close();
  server?.stop();
}

writeSummary(results);
writeContactSheet(results);

const failed = results.filter((result) => !isShotOk(result));
console.log(`[screenshots] ${results.length - failed.length}/${results.length} pages captured`);
if (failed.length > 0) {
  console.error(`[screenshots] ${failed.length} page(s) failed to render`);
  process.exit(1);
}
