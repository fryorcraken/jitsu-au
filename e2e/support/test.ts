// The suite's own `test` object. Import from here, never from `@playwright/test`.
//
// It is Playwright's test with one addition: every test is photographed where
// it finished, without the spec asking. That is what makes the gallery
// (scripts/e2e-gallery.mjs) complete by construction — a new spec is in it the
// day it is written, and a spec that stops taking pictures is a missing row a
// reviewer can see rather than a silence.
//
// `step` from ./screenshots is the other half: it photographs each named step
// on the way through, so a flow reads as a strip of screens in order.

import { test as base, expect } from "@playwright/test";

import { shot } from "./screenshots";

export const test = base.extend<{ finalShot: void }>({
  // `auto` so no spec has to request it. It runs after the test body and
  // before the page is torn down, which is the last moment the screen exists.
  finalShot: [
    async ({ page }, use, testInfo) => {
      await use();
      await shot(page, "where it ended", testInfo);
    },
    { auto: true },
  ],
});

export { expect };
export { shot, step } from "./screenshots";
