// Small helpers every spec reaches for. Keep this thin: a helper that hides
// what a test is asserting is worse than the two lines it saved.

import { expect, type Page } from "@playwright/test";

/**
 * Assert the page rendered itself rather than a failure boundary.
 *
 * Both the router's error boundary and its 404 render INSIDE an ordinary 200
 * response (src/routes/__root.tsx), so a status check alone would call a
 * site-wide "This page didn't load" a clean run. They carry `data-page-state`
 * for exactly this — the same contract the PR screenshots check.
 *
 * It does NOT catch a route that handles its own loader error and renders a
 * card in place of its content. If that matters to a flow, assert on the
 * content the flow needs.
 */
export async function expectPageRendered(page: Page) {
  await expect(page.locator("[data-page-state]")).toHaveCount(0);
}

/**
 * A header navigation link, at whatever width we are being run at.
 *
 * The header is inline from `lg` up and behind a menu button below it, and it
 * renders BOTH navigations into the DOM, hiding one by width
 * (src/components/site/SiteHeader.tsx). So a test that just clicked the link
 * would hit two matches on every width, and on a phone the one it found first
 * would be the hidden one. Open the menu if there is one, then take the copy a
 * person can actually see.
 */
export async function siteNavLink(page: Page, label: string) {
  const toggle = page.getByRole("button", { name: "Toggle menu" });
  if (await toggle.isVisible()) await toggle.click();
  return page.getByRole("link", { name: label, exact: true }).filter({ visible: true }).first();
}
