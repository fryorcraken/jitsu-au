#!/usr/bin/env bun
//
// Screenshot every page of a production build, at desktop and phone widths, so
// a pull request can be reviewed by looking at it.
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
// SIGNED-IN PAGES need a database with people in it, so they are photographed
// only when there is a seeded local Supabase stack to sign in against. Export
// the local values ONCE and keep them for the build and this script too — the
// build bakes VITE_SUPABASE_URL in, and signing in is a service-role admin call
// that this script refuses to make against anything but the stack the fixture
// was seeded from:
//
//   supabase start
//   eval "$(supabase status -o env)"
//   export SUPABASE_URL=$API_URL VITE_SUPABASE_URL=$API_URL
//   export SUPABASE_PUBLISHABLE_KEY=$ANON_KEY VITE_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
//   export SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
//   bun scripts/pr-screenshots-seed.mjs        # writes .screenshot-fixture.json
//   NITRO_PRESET=node-server bun run build
//   bun scripts/pr-screenshots.mjs
//
// With neither a fixture file nor a service-role key, the run photographs the
// public pages alone — what a local `bun scripts/pr-screenshots.mjs` against a
// production Supabase project should do, since signing in there is not
// something a screenshot run gets to do. One without the other is a broken
// setup rather than a smaller run, and fails (see readFixture).
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

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

import { PUBLIC_PAGES } from "../src/lib/seo.ts";
import { planSignedInGroups, signedInAvailability } from "./pr-screenshots-pages.mjs";
import {
  buildContactSheet,
  buildSummaryTable,
  failureReason,
  isShotOk,
  slugFor,
} from "./pr-screenshots-report.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Public pages that are deliberately absent from the sitemap and have to be
 * listed by hand.
 *
 * They are server-rendered `noindex` (see src/lib/seo.ts), and `seo.test.ts`
 * FAILS if a noindex page appears in `PUBLIC_PAGES` — so unlike the signed-in
 * pages, these can never be derived. A new public noindex page has to be added
 * here or it goes unphotographed.
 *
 * Not listed, because each needs a token or a session that only its own email
 * gives it: `/update-password`, `/email-settings/$token`, `/blog/$slug`.
 */
const EXTRA_PATHS = ["/waiver", "/auth", "/reset-password", "/thank-you", "/app"];

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
const ROUTES_DIR = join(REPO_ROOT, "src/routes");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PR_SCREENSHOTS_PORT ?? 4173);
/** Set to screenshot something already running (a dev server, a deploy). */
const EXTERNAL_BASE_URL = process.env.PR_SCREENSHOTS_BASE_URL;
/** Escape hatch for sandboxes that ship a chromium Playwright didn't install. */
const CHROMIUM_PATH = process.env.PR_SCREENSHOTS_CHROMIUM;

/**
 * The seeded local stack, if there is one: who to sign in as, and the record
 * ids that fill the dynamic routes. Written by pr-screenshots-seed.mjs.
 */
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  process.env.PR_SCREENSHOTS_FIXTURE ?? ".screenshot-fixture.json",
);
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const publicPaths = [...PUBLIC_PAGES.map((page) => page.path), ...EXTRA_PATHS];

/**
 * The pages to shoot, grouped by who is looking at them. One group is one
 * browser context: signing in is per-context, and doing it once per persona
 * beats doing it once per page.
 */
function buildGroups() {
  const fixture = readFixture();
  const groups = [{ persona: null, paths: publicPaths }];
  if (!fixture) return groups;
  return [...groups, ...planSignedInGroups(listRouteFiles(), fixture)];
}

/** Every route file, relative to `src/routes`, in a stable order. */
function listRouteFiles() {
  return readdirSync(ROUTES_DIR, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .sort();
}

/** The seed's manifest, or null when this run has no database to sign into. */
function readFixture() {
  const availability = signedInAvailability(
    existsSync(FIXTURE_PATH),
    Boolean(SUPABASE_URL && SERVICE_ROLE_KEY),
  );

  if (availability === "public-only") {
    console.log("[screenshots] no seeded stack: photographing the public pages only");
    return null;
  }
  if (availability === "no-manifest") {
    throw new Error(
      `A Supabase service-role key is set but there is no fixture manifest at ${FIXTURE_PATH}. Run scripts/pr-screenshots-seed.mjs first, or unset SUPABASE_SERVICE_ROLE_KEY to photograph the public pages alone.`,
    );
  }
  if (availability === "no-credentials") {
    throw new Error(
      `There is a fixture manifest at ${FIXTURE_PATH} but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so nobody can be signed in.`,
    );
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

  // Signing in is a SERVICE-ROLE admin call, and GoTrue's generate_link creates
  // the account when it does not exist — so pointed at the hosted project it
  // would put fixture people in the club's real auth, exactly what
  // `assertLocal` in the seed exists to prevent. The seed had that guard and
  // this did not, which matters because bun auto-loads `.env`: run the seed
  // with an explicit local URL and then this script bare, and the manifest is
  // local while the credentials are whatever `.env` holds.
  //
  // Checking the manifest's own URL is the stricter test — it catches a
  // production URL AND a different local stack — with the loopback rule behind
  // it for a manifest written before this field existed.
  assertLocalSupabase(SUPABASE_URL);
  if (fixture.supabaseUrl && fixture.supabaseUrl !== SUPABASE_URL) {
    throw new Error(
      `The fixture was seeded against ${fixture.supabaseUrl} but SUPABASE_URL is ${SUPABASE_URL}. Refusing to sign in: these are different databases.`,
    );
  }
  return fixture;
}

/**
 * Put back the fixture state that the act of photographing consumed, so every
 * viewport sees the same club.
 *
 * This is a KNOWN LIST, not a general undo: a future screen that marks
 * something read on open has to be added here, or its unread state will only
 * ever be photographed at the first width. Nothing detects that automatically —
 * the symptom is a mobile shot that looks calmer than its desktop twin.
 */
async function restoreFixtureState() {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const memberId = fixture.personas?.member?.userId;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // /notifications marks everything unread read when it opens.
  if (memberId) {
    await admin
      .from("notifications")
      .update({ read_at: null })
      .eq("user_id", memberId)
      .eq("kind", "new_blog_post");
  }
  // The manager screens keep one club-wide watermark per inbox
  // (src/lib/seen-markers.ts); deleting it makes the items unseen again.
  await admin
    .from("club_settings")
    .delete()
    .in("key", ["contact_messages_seen_at", "interest_registrations_seen_at"]);
}

/** Refuse to make admin calls against anything but a local stack. */
function assertLocalSupabase(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `Refusing to sign in against ${host}: the screenshot run only ever talks to a local stack.`,
    );
  }
}

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

/**
 * Sign `context` in as `email`, by walking it through a real Supabase email
 * link.
 *
 * The alternative — writing a session into localStorage ourselves — means
 * hard-coding the storage key the generated Supabase client happens to derive
 * from the project URL, and would go stale silently. An admin-generated magic
 * link goes through the app's own landing path instead (the one
 * `isAuthCallbackUrl` in src/lib/auth-persistence.ts exists for), so the
 * session is stored exactly the way a member's would be.
 *
 * The redirect target needs no configuration: GoTrue short-circuits its
 * allow-list check for a loopback address (`IsRedirectURLValid`), so any port
 * on 127.0.0.1 is accepted. PR_SCREENSHOTS_PORT can move on its own.
 */
async function signIn(context, baseUrl, email) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/account` },
  });
  if (error) throw new Error(`could not make a sign-in link for ${email}: ${error.message}`);

  const page = await context.newPage();
  try {
    await page.goto(data.properties.action_link, { waitUntil: "networkidle", timeout: 30_000 });
    // The link lands with tokens in the fragment and the client turns them into
    // a stored session a moment later. Waiting on the storage rather than on
    // the URL keeps this independent of where the app decides to send them.
    await page.waitForFunction(
      () => Object.keys(localStorage).some((key) => key.endsWith("-auth-token")),
      undefined,
      { timeout: 30_000 },
    );
  } finally {
    await page.close();
  }
}

async function shoot(context, baseUrl, viewport, path) {
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
    await page.close();
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

const groups = buildGroups();
const results = [];
let server;
let browser;

/** Photograph one group's pages in a context of its own, signed in or not. */
async function shootGroup(browser, baseUrl, viewport, group) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  try {
    if (group.persona) await signIn(context, baseUrl, group.email);
  } catch (error) {
    // A failed sign-in is one fault, not one per page — but every page it cost
    // us still has to appear in the summary, or the artifact just silently
    // lacks the whole member area.
    await context.close();
    console.error(`[screenshots] could not sign in as ${group.persona}: ${error}`);
    return group.paths.map((path) => ({
      path,
      viewport: viewport.name,
      status: 0,
      state: null,
      error: `sign-in as ${group.persona} failed: ${error}`,
    }));
  }

  try {
    const shots = [];
    for (const path of group.paths) {
      const result = await shoot(context, baseUrl, viewport, path);
      shots.push(result);
      console.log(
        `[screenshots] ${viewport.name.padEnd(7)} ${(group.persona ?? "public").padEnd(8)} ${path.padEnd(28)} ${
          isShotOk(result) ? `ok (${result.status})` : `FAILED ${failureReason(result)}`
        }`,
      );
    }
    return shots;
  } finally {
    await context.close();
  }
}

try {
  server = await startServer();
  browser = await chromium.launch({ executablePath: CHROMIUM_PATH || undefined });

  for (const [index, viewport] of VIEWPORTS.entries()) {
    // Photographing is not read-only: opening /notifications marks the member's
    // unread ones read, opening /manager/contact-messages stamps the club's
    // "seen up to here" marker. Left alone, the desktop pass would be the only
    // one to see an unread badge and the phone pass — the width most of this
    // club browses at — would show every screen already dealt with.
    if (index > 0 && groups.some((group) => group.persona)) await restoreFixtureState();
    for (const group of groups) {
      results.push(...(await shootGroup(browser, server.baseUrl, viewport, group)));
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
