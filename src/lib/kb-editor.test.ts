import { describe, it, expect } from "vitest";
import {
  isArticleDirty,
  isSectionDirty,
  moveEntry,
  moveSection,
  nextPosition,
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

describe("moveSection", () => {
  const list = [
    { slug: "a", position: 10 },
    { slug: "b", position: 20 },
    { slug: "c", position: 30 },
  ];

  it("moves a section up", () => {
    expect(moveSection(list, "b", 0)).toEqual([
      { slug: "b", position: 10 },
      { slug: "a", position: 20 },
    ]);
  });

  it("moves a section down", () => {
    expect(moveSection(list, "b", 2)).toEqual([
      { slug: "c", position: 20 },
      { slug: "b", position: 30 },
    ]);
  });

  it("returns only the rows that actually moved", () => {
    // "c" stays at 30, so it is not written.
    expect(moveSection(list, "a", 1).map((m) => m.slug)).toEqual(["b", "a"]);
  });

  it("writes nothing for a drop that goes nowhere", () => {
    expect(moveSection(list, "a", 0)).toEqual([]);
    expect(moveSection(list, "c", 2)).toEqual([]);
    expect(moveSection(list, "missing", 0)).toEqual([]);
  });

  it("keeps an index past either end inside the list", () => {
    expect(moveSection(list, "a", 99).map((m) => m.slug)).toEqual(["b", "c", "a"]);
    expect(moveSection(list, "c", -3).map((m) => m.slug)).toEqual(["c", "a", "b"]);
  });

  // The case a "swap the two numbers" implementation gets wrong: a knowledge
  // base nobody has ordered yet has everything on 0, so swapping positions
  // swaps 0 for 0 and the drag appears to be broken. Renumbering breaks the
  // tie on the first move.
  it("breaks a tie when nothing has been ordered yet", () => {
    const unordered = [
      { slug: "a", position: 0 },
      { slug: "b", position: 0 },
      { slug: "c", position: 0 },
    ];
    expect(moveSection(unordered, "c", 1)).toEqual([
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
    expect(moveSection(shown, "earlier", 0)).toEqual([{ slug: "later", position: 20 }]);
  });
});

describe("moveEntry", () => {
  const groups = () => [
    {
      slug: "start",
      entries: [
        { slug: "welcome", position: 10 },
        { slug: "house-rules", position: 20 },
        { slug: "kit", position: 30 },
      ],
    },
    { slug: "belts", entries: [{ slug: "syllabus", position: 10 }] },
    { slug: "empty", entries: [] },
    { slug: "", entries: [{ slug: "stray", position: 10 }] },
  ];

  it("moves an entry within its own section", () => {
    expect(moveEntry(groups(), "kit", "start", 0)).toEqual([
      { slug: "kit", section: "start", position: 10 },
      { slug: "welcome", section: "start", position: 20 },
      { slug: "house-rules", section: "start", position: 30 },
    ]);
  });

  it("moves an entry into another section, closing the gap behind it", () => {
    // Both lists are rewritten: "kit" lands in "belts", and "start" renumbers
    // around the hole it left.
    expect(moveEntry(groups(), "house-rules", "belts", 0)).toEqual([
      { slug: "kit", section: "start", position: 20 },
      { slug: "house-rules", section: "belts", position: 10 },
      { slug: "syllabus", section: "belts", position: 20 },
    ]);
  });

  it("moves an entry into a section with nothing in it", () => {
    expect(moveEntry(groups(), "syllabus", "empty", 0)).toEqual([
      { slug: "syllabus", section: "empty", position: 10 },
    ]);
  });

  // "Everything else" is a real drop target, not a state an entry can only fall
  // into by having its section deleted.
  it("moves an entry out of every section", () => {
    expect(moveEntry(groups(), "syllabus", "", 0)).toEqual([
      { slug: "syllabus", section: "", position: 10 },
      { slug: "stray", section: "", position: 20 },
    ]);
  });

  it("moves an entry out of the catch-all group into a section", () => {
    expect(moveEntry(groups(), "stray", "belts", 1)).toEqual([
      { slug: "stray", section: "belts", position: 20 },
    ]);
  });

  it("returns only the rows that actually moved", () => {
    // "welcome" is already first and stays on 10, so it is not written.
    expect(moveEntry(groups(), "kit", "start", 1)).toEqual([
      { slug: "kit", section: "start", position: 20 },
      { slug: "house-rules", section: "start", position: 30 },
    ]);
  });

  it("writes nothing for a drop that goes nowhere", () => {
    expect(moveEntry(groups(), "house-rules", "start", 1)).toEqual([]);
    expect(moveEntry(groups(), "missing", "start", 0)).toEqual([]);
  });

  // The index is read off the list as RENDERED, which still has the dragged
  // entry in it. Dropping "welcome" at the last slot has to leave it last.
  it("reads a same-section index against the list the entry has left", () => {
    expect(moveEntry(groups(), "welcome", "start", 2).map((m) => m.slug)).toEqual([
      "house-rules",
      "kit",
      "welcome",
    ]);
  });

  it("breaks a tie when nothing has been ordered yet", () => {
    const unordered = [
      {
        slug: "start",
        entries: [
          { slug: "a", position: 0 },
          { slug: "b", position: 0 },
        ],
      },
    ];
    expect(moveEntry(unordered, "b", "start", 0)).toEqual([
      { slug: "b", section: "start", position: 10 },
      { slug: "a", section: "start", position: 20 },
    ]);
  });

  // A drop onto a section this screen does not know about is an empty section
  // rather than a no-op: the manager screen keeps empty sections visible, and a
  // drag onto one that silently did nothing is the bug this replaced.
  it("treats an unknown section as an empty one", () => {
    expect(moveEntry(groups(), "syllabus", "brand-new", 0)).toEqual([
      { slug: "syllabus", section: "brand-new", position: 10 },
    ]);
  });
});

describe("isSectionDirty", () => {
  it("is clean against the stored name", () => {
    expect(isSectionDirty({ title: "Start here" }, { title: "Start here" })).toBe(false);
  });

  it("is dirty once the name is edited", () => {
    expect(isSectionDirty({ title: "Start here!" }, { title: "Start here" })).toBe(true);
  });

  // Whitespace is a real edit against a stored name: the manager typed it, and
  // the save trims it, so silently calling it clean would drop the correction.
  it("counts a whitespace-only difference as an edit", () => {
    expect(isSectionDirty({ title: "Start here " }, { title: "Start here" })).toBe(true);
  });

  it("has nothing to lose with nothing typed", () => {
    expect(isSectionDirty({ title: "   " }, null)).toBe(false);
    expect(isSectionDirty({ title: "New" }, null)).toBe(true);
  });
});
