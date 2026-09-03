// Every page this branch serves, opened and photographed.
//
// The flows in e2e/public, e2e/member and e2e/manager prove a person can get
// somewhere. This proves every screen RENDERS — and, because each test is
// photographed where it ended (e2e/support/test.ts), it is also what fills the
// page half of the gallery a reviewer opens on a pull request.
//
// The list is DERIVED, not written down: the public pages come from
// src/lib/public-pages.ts (the same list the sitemap is built from) and the
// signed-in ones from the route files themselves, so a new manager screen is
// walked the moment its file exists. scripts/site-pages.ts holds those rules
// and the unit suite pins them.
//
// What this catches that a status code does not: the router's error boundary
// and its 404 both render inside an ordinary 200 (src/routes/__root.tsx), so
// `expectPageRendered` is the assertion that a site-wide "This page didn't
// load" is not quietly photographed as a clean run. What it still does not
// catch is a route that handles its OWN loader error and renders a card in
// place of its content — /blog and /waiver do exactly that, so a green tour
// means every route rendered, not that every route has its data.

import { readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { publicPaths, signedInPathsByPersona } from "../../scripts/site-pages";
import { restoreSeenState } from "../support/club-state";
import { readClubFixture, storageStatePath } from "../support/fixture";
import { expectPageRendered } from "../support/page";
import { expect, test } from "../support/test";

const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/routes");

/** Every route file, relative to `src/routes`, in a stable order. */
function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .sort();
}

/** No session at all — an explicit empty state, not merely an unset one. */
const SIGNED_OUT = { cookies: [], origins: [] };

const clubFixture = readClubFixture();
const signedIn = signedInPathsByPersona(
  listRouteFiles(),
  clubFixture.params,
  clubFixture.paramsByPath,
);

async function visit(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "networkidle" });
  const status = response?.status() ?? 0;
  expect(status, `${path} never answered`).toBeGreaterThan(0);
  expect(status, `${path} answered ${status}`).toBeLessThan(400);
  await expectPageRendered(page);
}

test.describe("every page a visitor can open", () => {
  test.use({ storageState: SIGNED_OUT });

  for (const path of publicPaths()) {
    test(path, async ({ page }) => {
      await visit(page, path);
    });
  }
});

test.describe("every screen a member has", () => {
  test.use({ storageState: storageStatePath("member") });

  // Walking the member area SPENDS its unread state, and the tour runs twice
  // (desktop, then phone). Put it back so the second pass sees the club the
  // first one did.
  test.afterAll(restoreSeenState);

  for (const path of signedIn.member) {
    test(path, async ({ page }) => {
      await visit(page, path);
    });
  }
});

test.describe("every screen a manager has", () => {
  test.use({ storageState: storageStatePath("manager") });

  test.afterAll(restoreSeenState);

  for (const path of signedIn.manager) {
    test(path, async ({ page }) => {
      await visit(page, path);
    });
  }
});
