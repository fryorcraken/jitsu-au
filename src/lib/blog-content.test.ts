import { describe, expect, it } from "vitest";
import {
  deriveExcerpt,
  EXCERPT_MAX_LENGTH,
  extractYouTubeId,
  splitBlogContent,
} from "./blog-content";

describe("splitBlogContent", () => {
  it("returns a single markdown block for plain text", () => {
    expect(splitBlogContent("Hello\n\nWorld")).toEqual([
      { type: "markdown", text: "Hello\n\nWorld" },
    ]);
  });

  it("splits out a video line into its own block", () => {
    const body = "Intro paragraph.\n\n[[video:https://youtu.be/abc123]]\n\nOutro paragraph.";
    expect(splitBlogContent(body)).toEqual([
      { type: "markdown", text: "Intro paragraph.\n" },
      { type: "video", url: "https://youtu.be/abc123" },
      { type: "markdown", text: "\nOutro paragraph." },
    ]);
  });

  it("handles a body that is only a video", () => {
    expect(splitBlogContent("[[video:https://youtu.be/abc123]]")).toEqual([
      { type: "video", url: "https://youtu.be/abc123" },
    ]);
  });

  it("handles consecutive video lines as separate blocks", () => {
    const body = "[[video:https://youtu.be/one]]\n[[video:https://youtu.be/two]]";
    expect(splitBlogContent(body)).toEqual([
      { type: "video", url: "https://youtu.be/one" },
      { type: "video", url: "https://youtu.be/two" },
    ]);
  });
});

describe("extractYouTubeId", () => {
  it("reads the id from a youtu.be short link", () => {
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("reads the id from a youtube.com/watch link", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("reads the id from an embed link", () => {
    expect(extractYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("reads the id from a shorts link", () => {
    expect(extractYouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for a non-YouTube link", () => {
    expect(extractYouTubeId("https://vimeo.com/123456")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(extractYouTubeId("not a url")).toBeNull();
  });
});

describe("deriveExcerpt", () => {
  it("uses the opening prose of the post", () => {
    expect(deriveExcerpt("We ran a grading last Saturday.\n\nEveryone passed.")).toBe(
      "We ran a grading last Saturday. Everyone passed.",
    );
  });

  it("skips headings, which restate the title rather than open the post", () => {
    expect(deriveExcerpt("# Grading day\n\nEveryone passed.")).toBe("Everyone passed.");
  });

  it("keeps a link's text and drops its URL", () => {
    expect(deriveExcerpt("See the [timetable](https://jitsu.au/classes) for times.")).toBe(
      "See the timetable for times.",
    );
  });

  it("drops an image entirely rather than reading its alt text as prose", () => {
    expect(
      deriveExcerpt("![Two people training](https://example.com/a.png)\n\nWe train Mondays."),
    ).toBe("We train Mondays.");
  });

  it("strips emphasis but leaves an underscore inside a word alone", () => {
    expect(deriveExcerpt("A **big** _week_ for the snake_case club.")).toBe(
      "A big week for the snake_case club.",
    );
  });

  it("keeps list and blockquote text without their markers", () => {
    expect(deriveExcerpt("- Gi\n- Mouthguard\n\n> Bring water.")).toBe(
      "Gi Mouthguard Bring water.",
    );
  });

  it("ignores fenced code, rules and table rows", () => {
    expect(deriveExcerpt("```\nnpm install\n```\n\n---\n\n| a | b |\n\nReal words here.")).toBe(
      "Real words here.",
    );
  });

  it("skips video lines, which are not text", () => {
    expect(deriveExcerpt("[[video:https://youtu.be/abc]]\n\nA throw from last week.")).toBe(
      "A throw from last week.",
    );
  });

  it("cuts at a word boundary and marks the cut", () => {
    const excerpt = deriveExcerpt("alpha bravo charlie delta", 14);
    expect(excerpt).toBe("alpha bravo…");
    expect(excerpt.length).toBeLessThanOrEqual(14);
  });

  it("does not cut a body that fits", () => {
    const body = "Short enough.";
    expect(deriveExcerpt(body)).toBe(body);
    expect(deriveExcerpt("x".repeat(EXCERPT_MAX_LENGTH))).toHaveLength(EXCERPT_MAX_LENGTH);
  });

  it("returns an empty string when there is no prose to summarise", () => {
    expect(deriveExcerpt("")).toBe("");
    expect(deriveExcerpt("[[video:https://youtu.be/abc]]")).toBe("");
    expect(deriveExcerpt("## Just a heading")).toBe("");
  });

  it("stays inside the 500-character excerpt column limit", () => {
    expect(deriveExcerpt("word ".repeat(500)).length).toBeLessThanOrEqual(EXCERPT_MAX_LENGTH);
  });
});
