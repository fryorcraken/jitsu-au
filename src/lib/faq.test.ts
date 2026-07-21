import { describe, it, expect } from "vitest";
import { faqItems, homepageFaqIds, homepageFaqItems } from "./faq";

describe("faq content", () => {
  it("has unique, non-empty ids", () => {
    const ids = faqItems.map((f) => f.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every item has a question and an answer", () => {
    for (const item of faqItems) {
      expect(item.q.trim().length).toBeGreaterThan(0);
      expect(item.a.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("homepage FAQ selection", () => {
  it("surfaces exactly three reassuring questions", () => {
    expect(homepageFaqItems).toHaveLength(3);
  });

  it("only references ids that exist in the source of truth", () => {
    const ids = new Set(faqItems.map((f) => f.id));
    for (const id of homepageFaqIds) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("resolves to the same objects as the shared FAQ content (single source of truth)", () => {
    for (const item of homepageFaqItems) {
      expect(faqItems).toContain(item);
    }
  });

  // Guards the #9 anti-redundancy rule: the "Your first class" page already
  // covers gear and clothing, so the homepage trio must NOT repeat those.
  it("excludes the gear / clothing questions covered by the first-class page", () => {
    expect(homepageFaqIds).not.toContain("equipment");
    expect(homepageFaqIds).not.toContain("what-to-wear");
  });

  it("includes the experience, trial and JJJ-vs-BJJ reassurances", () => {
    expect(homepageFaqIds).toContain("experience");
    expect(homepageFaqIds).toContain("trial-offer");
    expect(homepageFaqIds).toContain("jjj-vs-bjj");
  });
});
