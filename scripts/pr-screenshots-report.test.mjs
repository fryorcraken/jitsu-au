import { describe, expect, it } from "vitest";

import {
  buildContactSheet,
  buildSummaryTable,
  escapeHtml,
  failureReason,
  isShotOk,
  slugFor,
} from "./pr-screenshots-report.mjs";

const VIEWPORTS = [
  { name: "desktop", width: 1280 },
  { name: "mobile", width: 390 },
];

/**
 * A page that rendered cleanly at one viewport. `file` only records that a PNG
 * was written; the contact sheet derives the src from the path and viewport,
 * the same way the entrypoint decides where to save it.
 */
function ok(path, viewport = "desktop") {
  return { path, viewport, status: 200, state: null, file: `${viewport}/${slugFor(path)}.png` };
}

describe("slugFor", () => {
  it("names the home page rather than producing an empty file name", () => {
    expect(slugFor("/")).toBe("home");
  });

  it("flattens nested paths so every shot lands in one directory", () => {
    expect(slugFor("/blog")).toBe("blog");
    expect(slugFor("/manager/kb")).toBe("manager-kb");
  });
});

describe("isShotOk", () => {
  it("passes a page that rendered", () => {
    expect(isShotOk(ok("/"))).toBe(true);
  });

  // The whole reason data-page-state exists: both failure boundaries render
  // inside a 200, so status alone called a broken site a clean run.
  it("fails a 200 that rendered the error boundary", () => {
    expect(isShotOk({ path: "/", viewport: "desktop", status: 200, state: "error" })).toBe(false);
  });

  it("fails a 200 that rendered the not-found boundary", () => {
    expect(isShotOk({ path: "/gone", viewport: "desktop", status: 200, state: "not-found" })).toBe(
      false,
    );
  });

  it("fails an error status", () => {
    expect(isShotOk({ path: "/", viewport: "desktop", status: 500, state: null })).toBe(false);
  });

  it("fails a shot that threw before it got a response", () => {
    expect(
      isShotOk({ path: "/", viewport: "desktop", status: 0, state: null, error: "Timeout" }),
    ).toBe(false);
  });

  it("fails a missing shot rather than treating it as a pass", () => {
    expect(isShotOk(undefined)).toBe(false);
  });
});

describe("failureReason", () => {
  it("names the boundary a page rendered", () => {
    expect(failureReason({ status: 200, state: "error" })).toBe("error page");
  });

  // The reason reaches a PR comment through GITHUB_ENV, so a raw Playwright
  // error string (multi-line, quotes, markdown) must never be passed through.
  it("reduces a thrown error to a fixed phrase", () => {
    expect(failureReason({ status: 0, error: "Error: page.goto\n`x`\n--- EOF ---" })).toBe(
      "did not load",
    );
  });

  it("reports an error status", () => {
    expect(failureReason({ status: 503, state: null })).toBe("HTTP 503");
  });
});

describe("buildSummaryTable", () => {
  it("puts one row per page with a column per viewport", () => {
    const table = buildSummaryTable([ok("/"), ok("/", "mobile"), ok("/faq")], VIEWPORTS);

    expect(table).toContain("| Page | desktop (1280px) | mobile (390px) |");
    expect(table).toContain("| `/` | 200 | 200 |");
    // No mobile shot for /faq: an em dash, not a silent pass.
    expect(table).toContain("| `/faq` | 200 | — |");
  });

  it("marks a page that rendered a boundary despite its 200", () => {
    const table = buildSummaryTable(
      [{ path: "/pricing", viewport: "desktop", status: 200, state: "error" }, ok("/", "mobile")],
      VIEWPORTS,
    );

    expect(table).toContain("| `/pricing` | ❌ error page | — |");
  });
});

describe("buildContactSheet", () => {
  it("links every captured page", () => {
    const sheet = buildContactSheet([ok("/"), ok("/faq")], VIEWPORTS);

    expect(sheet).toContain('<img src="desktop/home.png"');
    expect(sheet).toContain('<img src="desktop/faq.png"');
    expect(sheet).toContain("<h2>/faq</h2>");
  });

  it("keeps the picture of a failed page and says what went wrong", () => {
    const sheet = buildContactSheet(
      [{ path: "/", viewport: "desktop", status: 200, state: "error", file: "desktop/home.png" }],
      VIEWPORTS,
    );

    expect(sheet).toContain("failed: error page");
    expect(sheet).toContain('<img src="desktop/home.png"');
  });

  it("omits the image when the shot never wrote a file", () => {
    const sheet = buildContactSheet(
      [{ path: "/", viewport: "desktop", status: 0, state: null, error: "Timeout" }],
      VIEWPORTS,
    );

    expect(sheet).toContain("failed: did not load");
    expect(sheet).not.toContain("<img");
  });

  it("escapes text that would otherwise close a tag", () => {
    expect(escapeHtml('</figure><script>alert("x")</script>')).toBe(
      "&lt;/figure&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });
});
