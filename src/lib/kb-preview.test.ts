import { describe, expect, it } from "vitest";
import { PREVIEW_MAX_BLOCKS, articlePreview, kbArticleSlug } from "./kb-preview";

const SYLLABUS = [
  "# Syllabus",
  "What each belt asks of you.",
  "## Yellow belt",
  "The first grading.",
  "### Advanced body grab",
  "Step in, hips low, both arms round the waist.",
  "### Wrist lock",
  "Thumb on the back of the hand.",
  "## Orange belt",
  "The second grading.",
].join("\n\n");

describe("articlePreview", () => {
  // The whole point: "advanced body grab" in the syllabus shows what it is.
  it("shows the section a link names, without repeating its heading", () => {
    const preview = articlePreview(SYLLABUS, "advanced-body-grab");
    expect(preview.heading).toBe("Advanced body grab");
    expect(preview.markdown).toBe("Step in, hips low, both arms round the waist.");
    expect(preview.missingSection).toBeNull();
  });

  // A belt includes its own techniques, and stops at the next belt.
  it("runs to the next heading at the same depth or shallower", () => {
    const preview = articlePreview(SYLLABUS, "yellow-belt");
    expect(preview.markdown).toContain("Advanced body grab");
    expect(preview.markdown).toContain("Thumb on the back of the hand.");
    expect(preview.markdown).not.toContain("Orange");
  });

  it("accepts the fragment with or without its #, and in any case", () => {
    expect(articlePreview(SYLLABUS, "#Wrist-Lock").heading).toBe("Wrist lock");
  });

  it("shows the start of the article for a link with no section", () => {
    const preview = articlePreview(SYLLABUS);
    expect(preview.heading).toBeNull();
    expect(preview.markdown.startsWith("# Syllabus")).toBe(true);
    expect(preview.truncated).toBe(true);
  });

  // A renamed heading should not leave the card blank, nor pretend it worked.
  it("says so when the section is gone, and falls back to the start", () => {
    const preview = articlePreview(SYLLABUS, "green-belt");
    expect(preview.heading).toBeNull();
    expect(preview.missingSection).toBe("green-belt");
    expect(preview.markdown.startsWith("# Syllabus")).toBe(true);
  });

  it("stops after a handful of blocks and says there is more", () => {
    const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const preview = articlePreview(body);
    expect(preview.markdown.split("\n\n")).toHaveLength(PREVIEW_MAX_BLOCKS);
    expect(preview.truncated).toBe(true);
  });

  // An empty card for a passage that opens with one long paragraph would be
  // the preview failing at the only thing it is for.
  it("always shows the first block, however long", () => {
    const long = "word ".repeat(400).trim();
    const preview = articlePreview(`${long}\n\nShort one.`);
    expect(preview.markdown).toBe(long);
    expect(preview.truncated).toBe(true);
  });

  // One long block after a short one must not carry the card far past the
  // budget it exists to keep.
  it("leaves out a later block that would blow the budget", () => {
    const preview = articlePreview(`Short opener.\n\n${"word ".repeat(400).trim()}`);
    expect(preview.markdown).toBe("Short opener.");
    expect(preview.truncated).toBe(true);
  });

  it("does not claim more when the whole passage fits", () => {
    expect(articlePreview(SYLLABUS, "wrist-lock").truncated).toBe(false);
  });

  // The bug that shipped: the club's technique lists sit straight under their
  // headings with no blank line, which makes heading and list one block, and
  // every card for one of them said nothing was written there.
  it("keeps a list written straight under its heading", () => {
    const body = [
      "## Strikes",
      "",
      "### Open hand",
      "- Palm heel jab and cross",
      "- Forearm (inner/outer)",
      "",
      "### Closed fists",
      "- Jab",
    ].join("\n");
    const preview = articlePreview(body, "open-hand");
    expect(preview.heading).toBe("Open hand");
    expect(preview.markdown).toBe("- Palm heel jab and cross\n- Forearm (inner/outer)");
    expect(preview.truncated).toBe(false);

    // And a parent section still runs on through its children.
    expect(articlePreview(body, "strikes").markdown).toContain("- Jab");
  });

  // The same club style on both sides of a list: no blank line above the
  // next heading either. The section still stops at its sibling.
  it("stops at a sibling heading written with no blank line above it", () => {
    const body =
      "## Strikes\n\n### Open hand\n- Palm\n### Closed fists\n- Jab\n\n## Kicks\n\n- Mae geri";
    const preview = articlePreview(body, "open-hand");
    expect(preview.markdown).toBe("- Palm");
    expect(preview.truncated).toBe(false);
  });

  it("keeps a deeper heading written tight, and stops at none inside code", () => {
    const body = "## Strikes\n- Intro\n### Open hand\n- Palm\n\n## Kicks";
    expect(articlePreview(body, "strikes").markdown).toBe("- Intro\n\n### Open hand\n\n- Palm");

    const fenced = "## Example\n```\n# not a heading\n```\n\nAfter.";
    expect(articlePreview(fenced, "example").markdown).toBe("```\n# not a heading\n```\n\nAfter.");
  });

  // A plain trim would take the indent off and turn the code into a paragraph.
  it("keeps an indented code block under a heading as code", () => {
    const preview = articlePreview("### Example\n    const a = 1;\n    const b = 2;", "example");
    expect(preview.markdown).toBe("    const a = 1;\n    const b = 2;");
  });

  it("still says nothing is there when nothing is", () => {
    expect(articlePreview("### Open hand\n\n### Closed fists\n- Jab", "open-hand").markdown).toBe(
      "",
    );
  });

  it("answers to a pinned anchor", () => {
    const preview = articlePreview("## How grading works {#grading}\n\nTwice a year.", "grading");
    expect(preview.heading).toBe("How grading works");
    expect(preview.markdown).toBe("Twice a year.");
  });
});

describe("kbArticleSlug", () => {
  it("reads the slug off an article path", () => {
    expect(kbArticleSlug("/kb/syllabus")).toBe("syllabus");
    expect(kbArticleSlug("/kb/syllabus/")).toBe("syllabus");
  });

  // The index and anything that is not an article route have no preview.
  it("refuses everything that is not an article", () => {
    expect(kbArticleSlug("/kb")).toBeNull();
    expect(kbArticleSlug("/kb/")).toBeNull();
    expect(kbArticleSlug("/kb/a/b")).toBeNull();
    expect(kbArticleSlug("/faq")).toBeNull();
  });
});
