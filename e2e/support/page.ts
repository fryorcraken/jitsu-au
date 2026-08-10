// Small helpers every spec reaches for. Keep this thin: a helper that hides
// what a test is asserting is worse than the two lines it saved.

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Assert the page rendered itself rather than a failure boundary.
 *
 * Both the router's error boundary and its 404 render INSIDE an ordinary 200
 * response (src/routes/__root.tsx), so a status check alone would call a
 * site-wide "This page didn't load" a clean run. They carry `data-page-state`
 * for exactly this — the same contract the PR screenshots check.
 *
 * This is an ABSENCE check, so it passes on a page that has not rendered
 * anything yet. Assert the content the flow needs first, then this. It also
 * does not catch a route that handles its own loader error and renders a card
 * in place of its content.
 */
export async function expectPageRendered(page: Page) {
  await expect(page.locator("[data-page-state]")).toHaveCount(0);
}

/**
 * A header navigation link, at whatever width we are being run at.
 *
 * Two things make this more than a `getByRole`. The header is inline from `lg`
 * up and behind a menu button below it, and it renders BOTH navigations into
 * the DOM, hiding one by width (src/components/site/SiteHeader.tsx) — so a
 * plain locator matches twice on every width, and on a phone the copy it finds
 * first is the hidden one. And the menu button only works once React has
 * hydrated: a click that lands before then is swallowed silently, which on a
 * slow runner is a flaky test rather than a failing one.
 *
 * So the open is retried until the link it should have revealed is actually
 * there.
 */
export async function siteNavLink(page: Page, label: string): Promise<Locator> {
  const link = page.getByRole("link", { name: label, exact: true }).filter({ visible: true });
  const toggle = page.getByRole("button", { name: "Toggle menu" });

  await expect(async () => {
    // Only ever click a CLOSED menu, so a retry cannot close the one the
    // previous attempt opened.
    const open = await link.first().isVisible();
    if (!open && (await toggle.isVisible())) await toggle.click();
    await expect(link.first()).toBeVisible({ timeout: 1_000 });
  }).toPass();

  return link.first();
}
