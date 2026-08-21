// The pictures a run leaves behind.
//
// A screenshot here is a BYPRODUCT of a test that was going to be run anyway,
// not a separate program walking the site with its own idea of what a page is.
// That is the whole point of moving this into the suite: the gallery a reviewer
// opens shows the flow the tests actually walked — the interest form filled in,
// the waiver signed, the manager approving it — rather than a set of pages
// photographed cold.
//
// Everything here is Playwright's own API plus one web API:
//
//   - `page.screenshot()` for the picture (full page, animations frozen, caret
//     hidden — a blinking cursor is a pixel diff nobody asked for),
//   - `testInfo.attach()` to file it against the test, which is what puts it in
//     the HTML report AND in report.json, where scripts/e2e-gallery.mjs reads it,
//   - `document.fonts.ready` so a shot is never taken mid-swap, which would make
//     every page look like it changed.
//
// Nothing in here can fail a test. A missing picture is worth a warning; it is
// not worth turning a green flow red, and on a failing test the screenshot is
// being taken of a page that is already in a bad way.

import { test, type Page, type TestInfo } from "@playwright/test";

/** `E2E_SHOTS=0` skips capture, for when you are iterating on a test itself. */
const ENABLED = process.env.E2E_SHOTS !== "0";

/** Per-test counter, so file names order the way the flow ran. */
const taken = new WeakMap<TestInfo, number>();

function nextIndex(info: TestInfo): number {
  const next = (taken.get(info) ?? 0) + 1;
  taken.set(info, next);
  return next;
}

/**
 * A name for the temporary file, unique within one test.
 *
 * Only the temporary file: `testInfo.attach` files its own copy under a
 * content-hashed name of its choosing. What preserves the ORDER of a flow is
 * the report, which lists a test's attachments in the order they were added,
 * and that is what the gallery reads.
 */
function fileName(index: number, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${String(index).padStart(2, "0")}-${slug || "shot"}.png`;
}

/**
 * Photograph `page` and file it against the running test under `name`.
 *
 * Deliberately quiet on failure: a page mid-navigation, or one whose test just
 * threw, can refuse a screenshot, and that is not a reason to lose the test's
 * real result.
 */
export async function shot(page: Page, name: string, info: TestInfo = test.info()): Promise<void> {
  if (!ENABLED || page.isClosed()) return;

  try {
    // A font that arrives after the shot changes every glyph on the page, so
    // the next run's picture of an unchanged screen looks like a change.
    await page.evaluate(() => document.fonts.ready).catch(() => {});

    const file = info.outputPath(fileName(nextIndex(info), name));
    await page.screenshot({
      path: file,
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      scale: "css",
      timeout: 15_000,
    });
    await info.attach(name, { path: file, contentType: "image/png" });
  } catch (error) {
    console.warn(`[shots] could not photograph "${name}": ${error}`);
  }
}

/**
 * `test.step`, with a picture of where the step left the person.
 *
 * Use this rather than `test.step` in every spec — `scripts/e2e-conventions.test.ts`
 * fails the unit suite if a spec reaches for the bare one, because a step with
 * no picture is a hole in the flow that nobody notices until they are looking
 * for the screen it should have shown.
 *
 * The page is a parameter rather than something this could work out for itself:
 * a flow like the new-member journey drives three of them (an anonymous
 * visitor, the member, the manager), and which one a step is about is exactly
 * the thing worth being explicit on.
 *
 * The shot is taken in a `finally`, so a step that FAILS is photographed too.
 * That picture is usually the most useful one in the whole gallery.
 */
export async function step<T>(page: Page, title: string, body: () => Promise<T>): Promise<T> {
  return await test.step(title, async () => {
    try {
      return await body();
    } finally {
      await shot(page, title);
    }
  });
}
