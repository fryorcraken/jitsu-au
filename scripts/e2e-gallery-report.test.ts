import { describe, expect, it } from "vitest";

import {
  buildComment,
  buildGalleryHtml,
  buildSummary,
  collectEntries,
  entrySlug,
  flowGroups,
  pageAnchor,
  pageGroups,
  shotHref,
  tourProjects,
  type JsonReport,
} from "./e2e-gallery-report";

/** A run shaped the way Playwright's json reporter shapes one. */
const REPORT: JsonReport = {
  suites: [
    {
      title: "public/register-interest.spec.ts",
      file: "public/register-interest.spec.ts",
      specs: [
        {
          title: "registering interest lands the lead and offers the waiver",
          ok: true,
          tests: [
            {
              projectName: "public",
              status: "expected",
              results: [
                {
                  status: "passed",
                  attachments: [
                    {
                      name: "leaves their details",
                      contentType: "image/png",
                      path: "/tmp/a/01-leaves.png",
                    },
                    {
                      name: "is offered the waiver",
                      contentType: "image/png",
                      path: "/tmp/a/02-offered.png",
                    },
                    { name: "trace", contentType: "application/zip", path: "/tmp/a/trace.zip" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: "tour/site.spec.ts",
      file: "tour/site.spec.ts",
      suites: [
        {
          title: "every page a visitor can open",
          specs: [
            {
              title: "/pricing",
              ok: true,
              tests: [
                {
                  projectName: "tour",
                  status: "expected",
                  results: [
                    {
                      status: "passed",
                      attachments: [
                        {
                          name: "where it ended",
                          contentType: "image/png",
                          path: "/tmp/b/01-end.png",
                        },
                      ],
                    },
                  ],
                },
                {
                  projectName: "tour-mobile",
                  status: "expected",
                  results: [
                    {
                      status: "passed",
                      attachments: [
                        {
                          name: "where it ended",
                          contentType: "image/png",
                          path: "/tmp/c/01-end.png",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              title: "/faq",
              ok: false,
              tests: [
                {
                  projectName: "tour",
                  status: "unexpected",
                  results: [
                    {
                      status: "failed",
                      attachments: [
                        {
                          name: "where it ended",
                          contentType: "image/png",
                          path: "/tmp/d/01-end.png",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: "support/auth.setup.ts",
      file: "support/auth.setup.ts",
      specs: [
        {
          title: "sign in as the member",
          ok: true,
          tests: [
            {
              projectName: "setup",
              status: "expected",
              results: [{ status: "passed", attachments: [] }],
            },
          ],
        },
      ],
    },
  ],
};

const entries = collectEntries(REPORT);

describe("collectEntries", () => {
  it("makes one entry per test per project", () => {
    expect(entries.map((entry) => `${entry.project} ${entry.titlePath.at(-1)}`)).toEqual([
      "public registering interest lands the lead and offers the waiver",
      "tour /pricing",
      "tour-mobile /pricing",
      "tour /faq",
    ]);
  });

  it("keeps the screenshots in the order they were taken, and only the images", () => {
    expect(entries[0].shots.map((shot) => shot.name)).toEqual([
      "leaves their details",
      "is offered the waiver",
    ]);
  });

  it("drops the sign-in setup, which is plumbing rather than a flow", () => {
    expect(entries.some((entry) => entry.project === "setup")).toBe(false);
  });

  it("keeps the describe title but not the file's own repeated one", () => {
    expect(entries[1].titlePath).toEqual(["every page a visitor can open", "/pricing"]);
  });

  it("carries a failure through, so the gallery can show it", () => {
    expect(entries.at(-1)).toMatchObject({ ok: false, status: "unexpected" });
  });

  it("reads a retry's own result, not the attempt that failed", () => {
    const retried = collectEntries({
      suites: [
        {
          file: "member/account.spec.ts",
          specs: [
            {
              title: "the account page",
              ok: true,
              tests: [
                {
                  projectName: "member",
                  status: "flaky",
                  results: [
                    {
                      status: "failed",
                      attachments: [
                        { name: "first try", contentType: "image/png", path: "/tmp/x.png" },
                      ],
                    },
                    {
                      status: "passed",
                      attachments: [
                        { name: "second try", contentType: "image/png", path: "/tmp/y.png" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(retried[0].shots.map((shot) => shot.name)).toEqual(["second try"]);
  });
});

describe("grouping", () => {
  it("keeps flows and the page tour apart", () => {
    expect(flowGroups(entries).map((group) => group.file)).toEqual([
      "public/register-interest.spec.ts",
    ]);
    expect(pageGroups(entries).map((group) => group.path)).toEqual(["/pricing", "/faq"]);
  });

  it("pairs a page with its phone-width twin", () => {
    const pricing = pageGroups(entries)[0];
    expect([...pricing.byProject.keys()]).toEqual(["tour", "tour-mobile"]);
  });

  it("lists the widths the tour was walked at", () => {
    expect(tourProjects(entries)).toEqual(["tour", "tour-mobile"]);
  });
});

describe("shotHref", () => {
  it("files a shot under its own test, so two projects never overwrite each other", () => {
    const [flow, desktop, mobile] = entries;
    expect(shotHref(flow, flow.shots[0])).toBe(`shots/${entrySlug(flow)}/01-leaves.png`);
    expect(shotHref(desktop, desktop.shots[0])).not.toBe(shotHref(mobile, mobile.shots[0]));
  });
});

describe("buildGalleryHtml", () => {
  const html = buildGalleryHtml(entries, { title: "T", subtitle: "S" });

  it("shows the flow as a strip of named screens", () => {
    expect(html).toContain("leaves their details");
    expect(html).toContain("is offered the waiver");
  });

  it("shows every page the tour opened", () => {
    expect(html).toContain("/pricing");
    expect(html).toContain("/faq");
  });

  it("gives each page a stable id, so a review can link at one screen", () => {
    expect(html).toContain('id="page-faq"');
  });

  it("says which page failed, in words rather than Playwright's own", () => {
    expect(html).toContain("failed");
    expect(html).not.toContain("unexpected");
  });

  it("escapes what came out of a test title", () => {
    const nasty = buildGalleryHtml([{ ...entries[0], titlePath: ["<script>alert(1)</script>"] }], {
      title: "T",
      subtitle: "S",
    });
    expect(nasty).not.toContain("<script>alert(1)</script>");
    expect(nasty).toContain("&lt;script&gt;");
  });
});

describe("pageAnchor", () => {
  // These ids get pasted into pull request descriptions, so they have to keep
  // meaning the same screen from one run to the next.
  it("names a path after itself", () => {
    expect(pageAnchor("/faq")).toBe("page-faq");
    expect(pageAnchor("/manager/waivers")).toBe("page-manager-waivers");
  });

  // "/" slugs to nothing, so without its own case it would land on slugify's
  // fallback and collide with any other path that slugs away to nothing.
  it("does not let the home page fall back to a shared name", () => {
    expect(pageAnchor("/")).toBe("page-home");
    expect(pageAnchor("/")).not.toBe(pageAnchor("/!"));
  });
});

describe("buildSummary", () => {
  const summary = buildSummary(entries);

  it("counts the screenshots a flow produced", () => {
    expect(summary).toContain("| 2 | ✅ |");
  });

  it("marks the failed page", () => {
    expect(summary).toMatch(/\| `\/faq` \| ❌ failed/);
  });
});

describe("buildComment", () => {
  it("embeds the flow's pictures when the run was published somewhere", () => {
    const comment = buildComment(entries, {
      baseUrl: "https://example.test/pr-1",
      commit: "abc1234",
    });
    expect(comment).toContain('<img width="220"');
    expect(comment).toContain("<sub>leaves their details</sub>");
    expect(comment).toContain("https://example.test/pr-1/shots/");
    expect(comment).toContain("[**Open the gallery**](https://example.test/pr-1/index.html)");
    expect(comment).toContain("abc1234");
  });

  it("still says what happened when there is nowhere to publish to", () => {
    const comment = buildComment(entries, {});
    expect(comment).not.toContain("<img");
    expect(comment).toContain("registering interest lands the lead");
    expect(comment).toContain("| `/faq` |");
  });

  it("leads with the failure count when something failed", () => {
    expect(buildComment(entries, {})).toContain("1 failed");
  });

  it("sheds the pictures rather than being refused when a run is enormous", () => {
    // GitHub 422s a body over 65536 characters and the workflow posts with
    // continue-on-error, so an oversized comment would not fail — it would
    // silently never appear.
    const huge = Array.from({ length: 400 }, (_, index) => ({
      ...entries[0],
      titlePath: [`a flow with a reasonably long name, number ${index}`],
      shots: Array.from({ length: 12 }, (_, shot) => ({
        name: `a step with a reasonably long name, number ${shot}`,
        file: `/tmp/${index}-${shot}-with-a-long-attachment-name.png`,
      })),
    }));

    const comment = buildComment(huge, { baseUrl: "https://example.test/pr-1" });
    expect(comment.length).toBeLessThan(65_536);
    expect(comment).not.toContain("<img");
    expect(comment).toContain("more screenshots than a comment can hold");
    // The links are the whole point of the fallback.
    expect(comment).toContain("[**Open the gallery**](https://example.test/pr-1/index.html)");
  });
});
