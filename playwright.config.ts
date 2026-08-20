import { defineConfig, devices } from "@playwright/test";

import { storageStatePath } from "./e2e/support/fixture";

/**
 * End-to-end tests: the whole site, in a real browser, against a real database.
 *
 * The unit suite (vitest.config.ts) proves a rule or a component in isolation.
 * This proves a PERSON can get through a flow — fill the interest form and be
 * offered their waiver, be sent to the sign-in page when they ask for a member
 * screen signed out, sign in and find their account. Full instructions,
 * including how to run it locally, are in docs/e2e-tests.md.
 *
 * It is also where the pull request's screenshots come from. Every test is
 * photographed as it goes (e2e/support/screenshots.ts) and the `tour` projects
 * below open every page there is, so what a reviewer looks at is the flow the
 * tests walked rather than a set of pages photographed cold by a second
 * program. scripts/e2e-gallery.mjs turns the run into that gallery.
 *
 * Three things about the setup are load-bearing:
 *
 *  - It runs the PRODUCTION build (`.output/server/index.mjs`), not the dev
 *    server, because SSR and the server functions are most of what is being
 *    tested and only the build exercises them the way Cloudflare will.
 *  - It runs against a seeded local Supabase club (scripts/seed-local-club.mjs).
 *    Signing in walks a real Supabase magic link, so the session is stored
 *    exactly as a member's is.
 *  - It never talks to the hosted project. e2e/support/fixture.ts refuses any
 *    Supabase URL that is not loopback.
 */

/** Kept off Vite's own preview port so a dev server can stay up alongside. */
const PORT = Number(process.env.E2E_PORT ?? 4174);

/** Set to test something already running (a dev server, a preview deploy). */
const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",

  // A test left focused with `.only` passes the suite while skipping everything
  // else, which is invisible in a green check.
  forbidOnly: Boolean(process.env.CI),

  // One retry, for the genuine infrastructure flake of a browser against a
  // server against a database. It is not a licence for a flaky test: anything
  // that only passes on the second attempt is a bug to fix, and the trace from
  // the first attempt is attached to the report so it can be.
  retries: process.env.CI ? 1 : 0,

  // Every test shares ONE seeded club, and several of them write to it (an
  // interest registration, a waiver approval). Running them in parallel would
  // have tests reading each other's writes, so the suite is serial until it is
  // worth splitting the read-only tests out into their own parallel project.
  workers: 1,
  fullyParallel: false,

  // Twice Playwright's default. Every test now also photographs itself, a
  // full-page screenshot of a long page is not instant, and the flows here are
  // long on purpose (the new-member journey walks a dozen screens in one test).
  // A timeout that a slow runner trips is a red build with no bug behind it.
  timeout: 60_000,

  // The JSON report is what scripts/e2e-gallery.mjs reads to build the picture
  // gallery: it lists every test, its project, and the screenshots attached to
  // it, in the order they were taken. Written into `outputDir`, which is
  // emptied at the START of a run, so nothing here races the HTML reporter
  // writing its own folder at the end.
  reporter: process.env.CI
    ? [
        ["github"],
        ["list"],
        ["html", { open: "never" }],
        ["json", { outputFile: "./test-results/report.json" }],
      ]
    : [
        ["list"],
        ["html", { open: "never" }],
        ["json", { outputFile: "./test-results/report.json" }],
      ],

  use: {
    baseURL: BASE_URL,
    // Escape hatch for sandboxes that ship a chromium Playwright did not
    // install. Unset everywhere else, where the pinned browser is the right one
    // to use.
    launchOptions: { executablePath: process.env.E2E_CHROMIUM || undefined },
    // The deliberate screenshots are taken by e2e/support/screenshots.ts, which
    // is what the gallery is built from. These three are Playwright's own
    // failure record: kept only for a failure, so a green run stays small and a
    // red one can be replayed click by click from the report — including from
    // the report published to GitHub Pages, where the trace viewer opens
    // inline.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    // Signs the personas in once and saves their sessions, rather than every
    // signed-in test walking a magic link of its own.
    { name: "setup", testMatch: /support[\\/]auth\.setup\.ts/ },

    { name: "public", testDir: "./e2e/public", use: { ...devices["Desktop Chrome"] } },
    // Most of this club's traffic is phones, so the public flows are walked at
    // phone width too. The header nav is behind a menu button down there, which
    // is exactly the kind of difference a desktop-only run never sees.
    { name: "public-mobile", testDir: "./e2e/public", use: { ...devices["Pixel 5"] } },

    {
      name: "member",
      testDir: "./e2e/member",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: storageStatePath("member") },
    },
    {
      name: "manager",
      testDir: "./e2e/manager",
      dependencies: ["setup"],
      // Managers do their admin on a laptop, so that is the only width these
      // are walked at.
      use: { ...devices["Desktop Chrome"], storageState: storageStatePath("manager") },
    },
    // Every page the site serves, opened, asserted to have rendered, and
    // photographed — the job the standalone screenshot script used to do, now
    // one more thing the suite proves. Both widths, because a manager screen
    // that breaks on a phone is a manager screen that breaks.
    {
      name: "tour",
      testDir: "./e2e/tour",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "tour-mobile",
      testDir: "./e2e/tour",
      dependencies: ["setup"],
      use: { ...devices["Pixel 5"] },
    },
  ],

  // Nothing to start when E2E_BASE_URL points at a server someone else is
  // running. Otherwise: repair the build (see repair-traced-tslib.mjs — without
  // it a node-server build 500s every SSR request) and serve it.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: "bun scripts/repair-traced-tslib.mjs && node .output/server/index.mjs",
        url: BASE_URL,
        env: { HOST: "127.0.0.1", PORT: String(PORT) },
        // Locally, reuse whatever is already on the port; in CI, a server that
        // is already there is a leftover from something else and the run should
        // not quietly test it.
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      },
});
