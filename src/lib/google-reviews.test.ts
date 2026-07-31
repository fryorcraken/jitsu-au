import { describe, expect, it } from "vitest";
import { GOOGLE_RATING, GOOGLE_REVIEWS, GOOGLE_REVIEWS_URL } from "./google-reviews";

describe("google-reviews", () => {
  it("links out to the club's Google listing", () => {
    expect(GOOGLE_REVIEWS_URL).toMatch(/^https:\/\//);
  });

  it("shows a rating, not a placeholder", () => {
    expect(GOOGLE_RATING).toMatch(/^[1-5](\.\d)?$/);
  });

  it("carries three quotes, none of them the old placeholders", () => {
    expect(GOOGLE_REVIEWS).toHaveLength(3);
    for (const { name } of GOOGLE_REVIEWS) {
      expect(name.trim()).not.toBe("");
      // The strip shipped with "Jane Doe" / "John Doe" / "Joe Do" stand-ins.
      // Fabricated testimonials must never go live, so pin that they are gone.
      expect(name).not.toMatch(/\bdoe?$/i);
    }
    expect(new Set(GOOGLE_REVIEWS.map((r) => r.name)).size).toBe(GOOGLE_REVIEWS.length);
  });

  it("keeps every quote substantial and free of em dashes", () => {
    // Reviewers do write em dashes. The AGENTS.md copy rule bans them in the
    // site's own prose, so quotes are trimmed around them rather than quoting one.
    for (const { text } of GOOGLE_REVIEWS) {
      expect(text.trim().length).toBeGreaterThan(80);
      expect(text).not.toContain("—");
    }
  });
});
