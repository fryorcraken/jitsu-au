import { describe, expect, it } from "vitest";
import { extractYouTubeId, splitBlogContent } from "./blog-content";

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
