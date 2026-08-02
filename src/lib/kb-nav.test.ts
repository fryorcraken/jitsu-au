import { describe, expect, it } from "vitest";
import {
  adjacentEntries,
  buildKbNav,
  entryBreadcrumbs,
  entryHref,
  extractHeadings,
  flattenKbNav,
  headingSlug,
  kbProgress,
  parseHeading,
  readState,
  UNSECTIONED_TITLE,
  type KbEntryInput,
  type KbSectionInput,
} from "@/lib/kb-nav";

const sections: KbSectionInput[] = [
  { slug: "start-here", title: "Start here", position: 10 },
  { slug: "belts", title: "Belts and grading", position: 20 },
];

function entry(over: Partial<KbEntryInput> & { slug: string }): KbEntryInput {
  return {
    title: over.slug,
    link_path: null,
    section_slug: "start-here",
    position: 0,
    ...over,
  };
}

describe("buildKbNav", () => {
  it("orders sections by position, then articles by position inside each", () => {
    const nav = buildKbNav(sections, [
      entry({ slug: "syllabus", section_slug: "belts", position: 20 }),
      entry({ slug: "belt-system", section_slug: "belts", position: 10 }),
      entry({ slug: "first-belt", position: 20 }),
      entry({ slug: "off-the-mat", position: 10 }),
    ]);

    expect(nav.map((s) => s.slug)).toEqual(["start-here", "belts"]);
    expect(nav[0].entries.map((e) => e.slug)).toEqual(["off-the-mat", "first-belt"]);
    expect(nav[1].entries.map((e) => e.slug)).toEqual(["belt-system", "syllabus"]);
  });

  it("breaks a position tie by title, so the sidebar does not reshuffle itself", () => {
    // Everything defaults to position 0, which is the state of a knowledge base
    // nobody has ordered yet.
    const nav = buildKbNav(sections, [
      entry({ slug: "zebra", title: "Zebra" }),
      entry({ slug: "alpha", title: "Alpha" }),
    ]);
    expect(nav[0].entries.map((e) => e.slug)).toEqual(["alpha", "zebra"]);
  });

  it("puts articles with no section in a visible group at the end", () => {
    const nav = buildKbNav(sections, [
      entry({ slug: "loose", section_slug: null }),
      entry({ slug: "filed" }),
    ]);

    expect(nav).toHaveLength(2);
    expect(nav[1]).toMatchObject({ slug: null, title: UNSECTIONED_TITLE });
    expect(nav[1].entries.map((e) => e.slug)).toEqual(["loose"]);
  });

  it("treats an unknown section as unsectioned rather than dropping the article", () => {
    const nav = buildKbNav(sections, [entry({ slug: "orphan", section_slug: "deleted-section" })]);

    expect(flattenKbNav(nav).map((e) => e.slug)).toEqual(["orphan"]);
    expect(nav[0].slug).toBeNull();
  });

  it("hides a section that has no articles in it yet", () => {
    const nav = buildKbNav(sections, [entry({ slug: "first-belt" })]);
    expect(nav.map((s) => s.slug)).toEqual(["start-here"]);
  });

  it("resolves each entry's href, sending a link entry off to the main site", () => {
    const nav = buildKbNav(sections, [
      entry({ slug: "your-first-session", link_path: "/first-class", position: 5 }),
      entry({ slug: "first-belt", position: 10 }),
    ]);

    expect(nav[0].entries.map((e) => e.href)).toEqual(["/first-class", "/kb/first-belt"]);
    expect(nav[0].entries[0].section_title).toBe("Start here");
  });
});

describe("entryHref", () => {
  it("points at the article page when there is no link", () => {
    expect(entryHref({ slug: "our-history", link_path: null })).toBe("/kb/our-history");
  });

  it("points at the linked page when there is one", () => {
    expect(entryHref({ slug: "common-questions", link_path: "/faq" })).toBe("/faq");
  });
});

describe("adjacentEntries", () => {
  const nav = buildKbNav(sections, [
    entry({ slug: "your-first-session", link_path: "/first-class", position: 10 }),
    entry({ slug: "first-belt", position: 20 }),
    entry({ slug: "belt-system", section_slug: "belts", position: 10 }),
  ]);

  it("walks across a section boundary instead of dead-ending", () => {
    expect(adjacentEntries(nav, "first-belt").next?.slug).toBe("belt-system");
    expect(adjacentEntries(nav, "belt-system").previous?.slug).toBe("first-belt");
  });

  it("includes link entries in the reading order", () => {
    expect(adjacentEntries(nav, "first-belt").previous).toMatchObject({
      slug: "your-first-session",
      href: "/first-class",
    });
  });

  it("has nothing before the first entry or after the last", () => {
    expect(adjacentEntries(nav, "your-first-session").previous).toBeNull();
    expect(adjacentEntries(nav, "belt-system").next).toBeNull();
  });

  it("returns neither for a slug that is not in the knowledge base", () => {
    expect(adjacentEntries(nav, "nope")).toEqual({ previous: null, next: null });
  });
});

describe("entryBreadcrumbs", () => {
  const nav = buildKbNav(sections, [entry({ slug: "first-belt" })]);

  it("names the section an article sits in", () => {
    const crumbs = entryBreadcrumbs(nav, "first-belt");
    expect(crumbs?.section?.title).toBe("Start here");
    expect(crumbs?.entry.slug).toBe("first-belt");
  });

  it("returns null for an unknown slug", () => {
    expect(entryBreadcrumbs(nav, "nope")).toBeNull();
  });
});

describe("headingSlug", () => {
  it("makes a readable fragment", () => {
    expect(headingSlug("Your first grading")).toBe("your-first-grading");
  });

  it("collapses punctuation rather than keeping it in the URL", () => {
    expect(headingSlug("Gradings, fees & timing!")).toBe("gradings-fees-timing");
  });

  it("never returns an empty id", () => {
    expect(headingSlug("???")).toBe("section");
  });
});

describe("parseHeading", () => {
  it("reads the level and the text", () => {
    expect(parseHeading("## The blue belt")).toEqual({ depth: 2, text: "The blue belt" });
  });

  it("strips inline markdown so a table of contents reads as words", () => {
    expect(parseHeading("### The **blue** `belt` and [more](/x)")).toEqual({
      depth: 3,
      text: "The blue belt and more",
    });
  });

  it("ignores a closing run of hashes", () => {
    expect(parseHeading("## Grading ##")).toEqual({ depth: 2, text: "Grading" });
  });

  it("is not fooled by a hash that is not a heading", () => {
    expect(parseHeading("#hashtag")).toBeNull();
    expect(parseHeading("Some text\n## Not the first line")).toBeNull();
  });
});

describe("extractHeadings", () => {
  it("lists the headings in order with their block ids", () => {
    const headings = extractHeadings("# Syllabus\n\nIntro text.\n\n## White belt\n\nDetails.");
    expect(headings.map((h) => [h.depth, h.text, h.id])).toEqual([
      [1, "Syllabus", "syllabus"],
      [2, "White belt", "white-belt"],
    ]);
    expect(headings[0].blockId).toBeTruthy();
    expect(headings[0].blockId).not.toBe(headings[1].blockId);
  });

  it("ignores a # inside a fenced code block", () => {
    const headings = extractHeadings("## Real heading\n\n```sh\n# not a heading\n```\n");
    expect(headings.map((h) => h.text)).toEqual(["Real heading"]);
  });

  it("gives repeated headings distinct ids so both links work", () => {
    const headings = extractHeadings("## Grading\n\nA.\n\n## Grading\n\nB.\n\n## Grading\n\nC.");
    expect(headings.map((h) => h.id)).toEqual(["grading", "grading-2", "grading-3"]);
  });

  // A per-base counter collides with a number the author wrote themselves:
  // "Grading", "Grading 2", "Grading" used to mint `grading-2` twice, which put
  // two contents links on the same anchor and two elements on the same id.
  it("does not collide with a heading that already ends in a number", () => {
    const ids = extractHeadings("# Grading\n\na\n\n# Grading 2\n\nb\n\n# Grading\n\nc").map(
      (h) => h.id,
    );
    expect(ids).toEqual(["grading", "grading-2", "grading-3"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds nothing in an article that is all prose", () => {
    expect(extractHeadings("Just a paragraph.\n\nAnd another.")).toEqual([]);
  });
});

describe("buildKbNav visibility", () => {
  // Only a manager is ever handed a managers-only entry by the server, so this
  // is the signal that lets them tell a draft from a published page while
  // browsing rather than by opening each one.
  it("carries an entry's visibility through to the sidebar", () => {
    const nav = buildKbNav(sections, [
      entry({ slug: "draft-policy", visibility: "managers" }),
      entry({ slug: "published", visibility: "members" }),
    ]);
    const byId = Object.fromEntries(nav[0].entries.map((e) => [e.slug, e.visibility]));
    expect(byId).toEqual({ "draft-policy": "managers", published: "members" });
  });
});

describe("reading progress", () => {
  /** An article the reader has read at `read`, live at `live`. */
  const read = (slug: string, live: number, readVersion: number | null) =>
    entry({ slug, version: live, read_version: readVersion });

  it("counts an entry read at the live version as read", () => {
    expect(readState(buildKbNav(sections, [read("a", 3, 3)])[0].entries[0])).toBe("read");
  });

  it("counts one that has been rewritten since as updated, not read", () => {
    expect(readState(buildKbNav(sections, [read("a", 4, 3)])[0].entries[0])).toBe("updated");
  });

  it("counts one that was never opened as unread", () => {
    expect(readState(buildKbNav(sections, [read("a", 1, null)])[0].entries[0])).toBe("unread");
  });

  // A link entry points at a page on the marketing site, which has no way to
  // report back that somebody read it. Counting one would put a tick nobody can
  // ever earn in the denominator.
  it("leaves link entries out of the total entirely", () => {
    const nav = buildKbNav(sections, [
      read("a", 1, 1),
      entry({ slug: "faq", link_path: "/faq", position: 20 }),
    ]);
    expect(kbProgress(nav)).toMatchObject({ read: 1, total: 1 });
  });

  it("adds up what has been read across the whole knowledge base", () => {
    const nav = buildKbNav(sections, [
      read("a", 1, 1),
      { ...read("b", 2, 1), position: 20 },
      { ...read("c", 1, null), position: 30 },
    ]);
    expect(kbProgress(nav)).toMatchObject({ read: 1, updated: 1, total: 3 });
  });

  // Reading order, not "most recently opened": the order a manager set is the
  // onboarding path, so somebody who dipped into the syllabus is still sent
  // back to what comes next.
  it("points at the first entry that is unread or has changed", () => {
    const nav = buildKbNav(sections, [
      read("first", 1, 1),
      { ...read("second", 3, 2), position: 20 },
      { ...read("third", 1, null), position: 30 },
    ]);
    expect(kbProgress(nav).next?.slug).toBe("second");
  });

  it("has nothing left to point at once everything is read", () => {
    const nav = buildKbNav(sections, [read("a", 1, 1), { ...read("b", 2, 2), position: 20 }]);
    expect(kbProgress(nav).next).toBeNull();
  });

  // The empty knowledge base, and the one nobody has read: neither should make
  // the progress panel divide by zero or claim anything.
  it("says nothing about a knowledge base with nothing in it", () => {
    expect(kbProgress([])).toMatchObject({ read: 0, total: 0, updated: 0, next: null });
  });
});
