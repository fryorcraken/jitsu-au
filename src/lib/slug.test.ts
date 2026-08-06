import { describe, expect, it } from "vitest";
import { defaultBlogSlug, slugify, uniqueSlug } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("collapses punctuation into single hyphens", () => {
    expect(slugify("Grading Results: Winter 2026!!")).toBe("grading-results-winter-2026");
  });

  it("strips accents", () => {
    expect(slugify("Café Résumé")).toBe("cafe-resume");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  -- Hello -- ")).toBe("hello");
  });

  it("returns an empty string for a title with no alphanumeric characters", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("defaultBlogSlug", () => {
  const now = new Date("2026-08-06T03:00:00.000Z");

  it("prefixes the slugified title with today's date", () => {
    expect(defaultBlogSlug("Hello World", now)).toBe("2026-08-06-hello-world");
  });

  it("returns an empty string for a title with no alphanumeric characters", () => {
    expect(defaultBlogSlug("!!!", now)).toBe("");
  });

  it("truncates a near-max-length title so the date-prefixed slug still fits blog_posts' 200-char limit", () => {
    const title = "a".repeat(200);
    const slug = defaultBlogSlug(title, now);
    expect(slug.length).toBe(200);
    expect(slug).toBe(`2026-08-06-${"a".repeat(189)}`);
  });

  it("trims a trailing hyphen left by truncation, rather than producing an invalid slug", () => {
    // Slugified title is 190 chars with a hyphen right where the 189-char
    // truncation point falls, so a naive slice would end in "-".
    const title = `${"a".repeat(188)} b`;
    const slug = defaultBlogSlug(title, now);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe(`2026-08-06-${"a".repeat(188)}`);
  });
});

describe("uniqueSlug", () => {
  it("returns the base slug when it is not taken", () => {
    expect(uniqueSlug("hello-world", new Set())).toBe("hello-world");
  });

  it("appends -2 when the base is taken", () => {
    expect(uniqueSlug("hello-world", new Set(["hello-world"]))).toBe("hello-world-2");
  });

  it("keeps incrementing past existing numbered collisions", () => {
    const taken = new Set(["hello-world", "hello-world-2", "hello-world-3"]);
    expect(uniqueSlug("hello-world", taken)).toBe("hello-world-4");
  });
});
