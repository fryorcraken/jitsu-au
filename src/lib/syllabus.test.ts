import { describe, expect, it } from "vitest";
import {
  EMPTY_BELT_PAGE,
  beltPageSlug,
  beltPageTitle,
  composeBeltPage,
  entryProblem,
  flattenTopics,
  orderBelts,
  sameBlocks,
  syllabusView,
  syllabusViewMarkdown,
  tidyBlock,
  topicHeading,
  topicTree,
  type SyllabusBelt,
  type SyllabusData,
  type SyllabusEntry,
  type SyllabusTopic,
} from "./syllabus";
import { extractHeadings } from "./kb-nav";

const belt = (slug: string, position: number, extra: Partial<SyllabusBelt> = {}): SyllabusBelt => ({
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  grade: null,
  colour: "#000000",
  position,
  page_slug: beltPageSlug(slug),
  visibility: "members",
  ...extra,
});

// The club's topics as the migration seeds them.
const TOPICS: SyllabusTopic[] = [
  { slug: "breakfalling", title: "Breakfalling", parent: null, position: 10 },
  { slug: "striking", title: "Striking", parent: null, position: 20 },
  { slug: "techniques", title: "Techniques", parent: null, position: 30 },
  { slug: "throws", title: "Throws", parent: "techniques", position: 10 },
  { slug: "locks", title: "Locks", parent: "techniques", position: 30 },
  { slug: "groundwork-ne-waza", title: "Groundwork (Ne Waza)", parent: "techniques", position: 50 },
  { slug: "uke", title: "Uke", parent: null, position: 40 },
  { slug: "drills", title: "Drills", parent: null, position: 90 },
];

const entry = (beltSlug: string, topic: string, body_md: string): SyllabusEntry => ({
  belt: beltSlug,
  topic,
  body_md,
});

describe("belt pages", () => {
  it("keeps the titles and slugs the pages already had", () => {
    expect(beltPageSlug("dark-blue")).toBe("dark-blue-belt");
    expect(beltPageTitle({ name: "Dark Blue", grade: "2nd Kyu" })).toBe("Dark Blue belt (2nd Kyu)");
    expect(beltPageTitle({ name: "White", grade: null })).toBe("White belt");
  });

  it("orders belts junior first, with a stable tie-break", () => {
    const ordered = orderBelts([belt("green", 40), belt("yellow", 20), belt("orange", 20)]);
    expect(ordered.map((b) => b.slug)).toEqual(["orange", "yellow", "green"]);
  });
});

describe("topicTree", () => {
  it("nests sub-topics under their topic, both in position order", () => {
    const tree = topicTree([...TOPICS].reverse());
    expect(tree.map((t) => t.slug)).toEqual([
      "breakfalling",
      "striking",
      "techniques",
      "uke",
      "drills",
    ]);
    expect(tree[2].children.map((t) => t.slug)).toEqual(["throws", "locks", "groundwork-ne-waza"]);
    expect(flattenTopics(tree).map((t) => t.slug)).toEqual([
      "breakfalling",
      "striking",
      "techniques",
      "throws",
      "locks",
      "groundwork-ne-waza",
      "uke",
      "drills",
    ]);
  });

  it("shows a sub-topic whose parent is missing at the top level rather than losing it", () => {
    const tree = topicTree([{ slug: "lost", title: "Lost", parent: "gone", position: 5 }]);
    expect(tree).toEqual([
      { slug: "lost", title: "Lost", parent: null, position: 5, children: [] },
    ]);
  });
});

describe("topicHeading", () => {
  it("writes a heading bare when its words already give its anchor", () => {
    expect(topicHeading({ slug: "groundwork-ne-waza", title: "Groundwork (Ne Waza)" }, 3)).toBe(
      "### Groundwork (Ne Waza)",
    );
  });

  it("pins the anchor once a rename means the words no longer give it", () => {
    const heading = topicHeading({ slug: "breakfalling", title: "Ukemi" }, 2);
    expect(heading).toBe("## Ukemi {#breakfalling}");
    // And the reader agrees: the old links still land on it.
    expect(extractHeadings(heading)[0]).toMatchObject({ id: "breakfalling", text: "Ukemi" });
  });
});

// A belt page as it was written before the syllabus was structured: lists
// straight under each heading, no blank line between.
const YELLOW_AS_WRITTEN = `## Breakfalling
- Kneeling breakfalling: forward, backward, sideways
- Peg leg

## Striking
- Aim and generate power using [open hand](/kb/core-techniques#open-hand).

## Techniques

### Throws
- Ko Soto Gake, O Soto Gari

### Locks
- **Wrist Locks**: WL3 (Kote Gatame)

## Uke
- Deliver clean, controlled straight open hands.

## Drills
- [Box breathing](/kb/practice#drills)`;

// What the migration's import files under each topic for that page.
const YELLOW_ENTRIES = [
  entry(
    "yellow",
    "breakfalling",
    "- Kneeling breakfalling: forward, backward, sideways\n- Peg leg",
  ),
  entry(
    "yellow",
    "striking",
    "- Aim and generate power using [open hand](/kb/core-techniques#open-hand).",
  ),
  entry("yellow", "throws", "- Ko Soto Gake, O Soto Gari"),
  entry("yellow", "locks", "- **Wrist Locks**: WL3 (Kote Gatame)"),
  entry("yellow", "uke", "- Deliver clean, controlled straight open hands."),
  entry("yellow", "drills", "- [Box breathing](/kb/practice#drills)"),
];

describe("composeBeltPage", () => {
  it("puts an imported page back together block for block", () => {
    const composed = composeBeltPage("yellow", TOPICS, YELLOW_ENTRIES);
    // Not the same text (blank lines under each heading), but the same page,
    // which is what decides whether comments stay attached and whether a new
    // version is worth publishing.
    expect(composed).not.toBe(YELLOW_AS_WRITTEN);
    expect(sameBlocks(composed, YELLOW_AS_WRITTEN)).toBe(true);
    // Every anchor the page had, it still has.
    expect(extractHeadings(composed).map((h) => h.id)).toEqual(
      extractHeadings(YELLOW_AS_WRITTEN).map((h) => h.id),
    );
  });

  it("leaves out a topic the belt has nothing on", () => {
    const composed = composeBeltPage("yellow", TOPICS, [entry("yellow", "uke", "- Attack.")]);
    expect(composed).toBe("## Uke\n\n- Attack.");
  });

  it("writes the parent heading for a sub-topic even with no text of its own", () => {
    const composed = composeBeltPage("yellow", TOPICS, [entry("yellow", "locks", "- AL1")]);
    expect(composed).toBe("## Techniques\n\n### Locks\n\n- AL1");
  });

  it("writes a parent's own text before its sub-topics", () => {
    const composed = composeBeltPage("yellow", TOPICS, [
      entry("yellow", "throws", "- O Goshi"),
      entry("yellow", "techniques", "Everything below, from both sides."),
    ]);
    expect(composed).toBe(
      "## Techniques\n\nEverything below, from both sides.\n\n### Throws\n\n- O Goshi",
    );
  });

  it("only ever reads the belt it was asked for", () => {
    const composed = composeBeltPage("yellow", TOPICS, [
      entry("green", "uke", "- Green's text"),
      entry("yellow", "uke", "- Yellow's text"),
    ]);
    expect(composed).not.toContain("Green");
  });

  it("says so when a belt has nothing written yet", () => {
    expect(composeBeltPage("white", TOPICS, [])).toBe(EMPTY_BELT_PAGE);
  });
});

describe("sameBlocks", () => {
  it("sees a reordered page as a change", () => {
    const reordered = "## Uke\n- a\n\n## Breakfalling\n- b";
    expect(sameBlocks(reordered, "## Breakfalling\n- b\n\n## Uke\n- a")).toBe(false);
  });

  it("sees a change of wording as a change", () => {
    expect(sameBlocks("## Uke\n- a", "## Uke\n- b")).toBe(false);
  });
});

describe("entryProblem", () => {
  it("refuses a heading inside a block", () => {
    expect(entryProblem("- one\n\n### Another section\n- two")).toMatch(/headings/);
  });

  it("accepts ordinary content, including a # inside a code sample", () => {
    expect(entryProblem("- **Bold** [link](/kb/x)\n\nA sentence.")).toBeNull();
    expect(entryProblem("```\n# not a heading\n```")).toBeNull();
  });
});

describe("syllabusView", () => {
  const data: SyllabusData = {
    belts: [
      belt("white", 10, { page_slug: null, visibility: null }),
      belt("yellow", 20),
      belt("orange", 30),
      belt("green", 40),
      belt("purple", 50),
    ],
    topics: TOPICS,
    entries: [
      entry("yellow", "breakfalling", "- Peg leg"),
      entry("green", "breakfalling", "- Judo rolls"),
      entry("purple", "breakfalling", "- Handstand"),
      entry("orange", "throws", "- O Goshi"),
      entry("green", "locks", "- AL5"),
      entry("yellow", "uke", "- Open hands"),
    ],
  };

  it("shows everything up to and including the belt asked for, junior first", () => {
    const view = syllabusView(data, { upTo: "green" });
    expect(view.belts.map((b) => b.slug)).toEqual(["yellow", "orange", "green"]);
    const breakfalling = view.sections.find((s) => s.slug === "breakfalling")!;
    expect(breakfalling.entries.map((e) => e.belt.slug)).toEqual(["yellow", "green"]);
    expect(breakfalling.entries.map((e) => e.body_md)).not.toContain("- Handstand");
  });

  it("skips a belt with nothing on a topic, and a topic nobody in range has", () => {
    const view = syllabusView(data, { upTo: "orange" });
    expect(view.sections.map((s) => s.slug)).toEqual(["breakfalling", "techniques", "uke"]);
    const techniques = view.sections.find((s) => s.slug === "techniques")!;
    expect(techniques.entries).toEqual([]);
    expect(techniques.children.map((c) => c.slug)).toEqual(["throws"]);
  });

  it("offers only belts with a page, so white is never in it", () => {
    const view = syllabusView(data);
    expect(view.choices.map((b) => b.slug)).toEqual(["yellow", "orange", "green", "purple"]);
  });

  it("runs to the most senior belt when no belt is named", () => {
    const view = syllabusView(data);
    expect(view.upTo?.slug).toBe("purple");
    expect(view.unknownUpTo).toBeNull();
  });

  it("reports a belt it does not know rather than quietly showing everything", () => {
    const view = syllabusView(data, { upTo: "blue" });
    expect(view.upTo?.slug).toBe("purple");
    expect(view.unknownUpTo).toBe("blue");
  });

  it("narrows to one topic", () => {
    const view = syllabusView(data, { topic: "breakfalling" });
    expect(view.sections.map((s) => s.slug)).toEqual(["breakfalling"]);
    expect(view.topic?.slug).toBe("breakfalling");
  });

  it("narrows to a whole topic with its sub-topics", () => {
    const view = syllabusView(data, { topic: "techniques" });
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].children.map((c) => c.slug)).toEqual(["throws", "locks"]);
  });

  it("narrows to one sub-topic, and says which topic it belongs to", () => {
    const view = syllabusView(data, { topic: "locks", upTo: "green" });
    expect(view.sections).toEqual([
      expect.objectContaining({ slug: "locks", depth: 3, children: [] }),
    ]);
    expect(view.topicParent?.slug).toBe("techniques");
  });

  it("reports a topic it does not know", () => {
    const view = syllabusView(data, { topic: "weapons" });
    expect(view.unknownTopic).toBe("weapons");
    expect(view.topic).toBeNull();
  });

  it("is empty, not broken, when no belt has a page yet", () => {
    const view = syllabusView({
      belts: [belt("white", 10, { page_slug: null })],
      topics: TOPICS,
      entries: [],
    });
    expect(view.upTo).toBeNull();
    expect(view.sections).toEqual([]);
  });

  it("reads as one document for the agent API", () => {
    const md = syllabusViewMarkdown(syllabusView(data, { upTo: "green", topic: "breakfalling" }));
    expect(md).toBe(
      "## Breakfalling\n\n**Yellow belt**\n\n- Peg leg\n\n**Green belt**\n\n- Judo rolls",
    );
  });
});

describe("tidyBlock", () => {
  it("drops blank lines and trailing space at the ends, but keeps a first line's indentation", () => {
    expect(tidyBlock("\n\n    const a = 1;\n    const b = 2;\n\n  ")).toBe(
      "    const a = 1;\n    const b = 2;",
    );
  });

  it("keeps an indented code block a code block on the assembled page", () => {
    const page = composeBeltPage("yellow", TOPICS, [
      entry("yellow", "uke", "    count: 1, 2, 3\n"),
    ]);
    expect(page).toBe("## Uke\n\n    count: 1, 2, 3");
  });
});
