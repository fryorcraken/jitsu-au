import { describe, it, expect } from "vitest";
import {
  isArticleDirty,
  nextPosition,
  reorder,
  slugFromTitle,
  wideningVisibility,
} from "./kb-editor";
import type { ArticleDraft } from "./kb-editor";

const stored: ArticleDraft = {
  title: "House rules",
  body_md: "# Rules",
  visibility: "members",
  annotations_enabled: true,
  section: "start-here",
  position: 20,
  nav_title: "",
  link_path: "",
};

describe("isArticleDirty", () => {
  it("is clean against an identical draft", () => {
    expect(isArticleDirty({ ...stored }, stored)).toBe(false);
  });

  it("notices every field a save would keep", () => {
    expect(isArticleDirty({ ...stored, title: "Rules" }, stored)).toBe(true);
    expect(isArticleDirty({ ...stored, body_md: "# Other" }, stored)).toBe(true);
    expect(isArticleDirty({ ...stored, visibility: "managers" }, stored)).toBe(true);
    expect(isArticleDirty({ ...stored, annotations_enabled: false }, stored)).toBe(true);
  });

  // Placement is work a save would keep too. Without it, a manager who moved an
  // article into "Start here" and then clicked another one lost the move with
  // nothing on screen having said so.
  it("notices a change of placement", () => {
    expect(isArticleDirty({ ...stored, section: "about-the-club" }, stored)).toBe(true);
    expect(isArticleDirty({ ...stored, position: 30 }, stored)).toBe(true);
    expect(isArticleDirty({ ...stored, nav_title: "Rules" }, stored)).toBe(true);
    expect(isArticleDirty({ ...stored, link_path: "/faq" }, stored)).toBe(true);
  });

  // While creating there is no stored version, but anything typed is still
  // unsaved work. Returning false here let "New article" wipe a fully typed
  // article with no prompt.
  it("treats typed content with nothing stored as unsaved work", () => {
    expect(isArticleDirty({ ...stored, title: "Anything" }, null)).toBe(true);
    expect(isArticleDirty({ ...stored, title: "", body_md: "# Draft" }, null)).toBe(true);
  });

  it("is clean when nothing is stored and nothing has been typed", () => {
    expect(isArticleDirty({ ...stored, title: "", body_md: "" }, null)).toBe(false);
    expect(isArticleDirty({ ...stored, title: "   ", body_md: "  " }, null)).toBe(false);
  });
});

describe("wideningVisibility", () => {
  // The click worth confirming: a draft that has been managers-only while it was
  // written, going out to everyone.
  it("flags a widening change", () => {
    expect(wideningVisibility("managers", "members")).toEqual({
      from: "managers",
      to: "members",
    });
  });

  // Taking an article away from people is recoverable and unsurprising.
  it("does not flag a narrowing change", () => {
    expect(wideningVisibility("members", "managers")).toBeNull();
  });

  it("does not flag an unchanged visibility, or a brand-new article", () => {
    expect(wideningVisibility("members", "members")).toBeNull();
    expect(wideningVisibility("managers", "managers")).toBeNull();
    expect(wideningVisibility(null, "members")).toBeNull();
  });
});

describe("slugFromTitle", () => {
  it("proposes a slug the database will accept", () => {
    expect(slugFromTitle("House Rules")).toBe("house-rules");
    expect(slugFromTitle("2027 Fee Proposal")).toBe("2027-fee-proposal");
  });

  it("collapses punctuation and trims stray hyphens", () => {
    expect(slugFromTitle("  What's the plan?!  ")).toBe("what-s-the-plan");
    expect(slugFromTitle("--Draft--")).toBe("draft");
  });

  // Built on `slugify`, which normalises accents. A hand-rolled ASCII filter
  // turns "Café" into "caf-", which is legal but not the word.
  it("keeps accented words readable", () => {
    expect(slugFromTitle("Café etiquette")).toBe("cafe-etiquette");
    expect(slugFromTitle("Après-training notes")).toBe("apres-training-notes");
  });

  // The CHECK caps the slug at 100 characters, and a trailing hyphen left by the
  // cut would be rejected outright.
  it("caps the length without leaving a trailing hyphen", () => {
    const slug = slugFromTitle(`${"a".repeat(99)} b`);
    expect(slug.length).toBeLessThanOrEqual(100);
    expect(slug.endsWith("-")).toBe(false);
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)).toBe(true);
  });

  it("gives back nothing when the title has nothing usable in it", () => {
    expect(slugFromTitle("!!!")).toBe("");
    expect(slugFromTitle("   ")).toBe("");
  });
});

describe("nextPosition", () => {
  it("puts a new entry after everything already there", () => {
    expect(
      nextPosition([
        { slug: "a", position: 10 },
        { slug: "b", position: 20 },
      ]),
    ).toBe(30);
  });

  it("starts at the step when the section is empty", () => {
    expect(nextPosition([])).toBe(10);
  });

  // The reason this exists rather than defaulting to 0: a brand-new article at
  // position 0 lands ABOVE the article a manager deliberately made the first
  // thing a new member reads.
  it("never proposes the top of the section", () => {
    expect(nextPosition([{ slug: "a", position: 0 }])).toBe(10);
  });
});

describe("reorder", () => {
  const list = [
    { slug: "a", position: 10 },
    { slug: "b", position: 20 },
    { slug: "c", position: 30 },
  ];

  it("swaps an entry with the one above it", () => {
    expect(reorder(list, "b", -1)).toEqual([
      { slug: "b", position: 10 },
      { slug: "a", position: 20 },
    ]);
  });

  it("swaps an entry with the one below it", () => {
    expect(reorder(list, "b", 1)).toEqual([
      { slug: "c", position: 20 },
      { slug: "b", position: 30 },
    ]);
  });

  it("returns only the rows that actually moved", () => {
    // "c" stays at 30, so it is not written.
    expect(reorder(list, "a", 1).map((m) => m.slug)).toEqual(["b", "a"]);
  });

  it("does nothing at either end", () => {
    expect(reorder(list, "a", -1)).toEqual([]);
    expect(reorder(list, "c", 1)).toEqual([]);
    expect(reorder(list, "missing", 1)).toEqual([]);
  });

  // The case a "swap the two numbers" implementation gets wrong: a knowledge
  // base nobody has ordered yet has everything on 0, so swapping positions
  // swaps 0 for 0 and the arrow appears to be broken. Renumbering breaks the
  // tie on the first click.
  it("breaks a tie when nothing has been ordered yet", () => {
    const unordered = [
      { slug: "a", position: 0 },
      { slug: "b", position: 0 },
      { slug: "c", position: 0 },
    ];
    expect(reorder(unordered, "c", -1)).toEqual([
      { slug: "a", position: 10 },
      { slug: "c", position: 20 },
      { slug: "b", position: 30 },
    ]);
  });

  // The list is taken in the order it is DISPLAYED. Re-sorting here by anything
  // of its own would move whatever this function thought was above, rather than
  // what the manager can see is above.
  it("trusts the order it is given", () => {
    const shown = [
      { slug: "later", position: 30 },
      { slug: "earlier", position: 10 },
    ];
    // "earlier" is already on 10 and stays there, so the only write is the row
    // that had to move out of its way.
    expect(reorder(shown, "earlier", -1)).toEqual([{ slug: "later", position: 20 }]);
  });
});
