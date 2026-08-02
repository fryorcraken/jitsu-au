import { describe, it, expect } from "vitest";
import { isDocumentDirty, slugFromTitle, wideningVisibility } from "./kb-editor";
import type { DocumentDraft } from "./kb-editor";

const stored: DocumentDraft = {
  title: "House rules",
  body_md: "# Rules",
  visibility: "members",
  annotations_enabled: true,
};

describe("isDocumentDirty", () => {
  it("is clean against an identical draft", () => {
    expect(isDocumentDirty({ ...stored }, stored)).toBe(false);
  });

  it("notices every field a save would keep", () => {
    expect(isDocumentDirty({ ...stored, title: "Rules" }, stored)).toBe(true);
    expect(isDocumentDirty({ ...stored, body_md: "# Other" }, stored)).toBe(true);
    expect(isDocumentDirty({ ...stored, visibility: "public" }, stored)).toBe(true);
    expect(isDocumentDirty({ ...stored, annotations_enabled: false }, stored)).toBe(true);
  });

  // While creating there is no stored version, but anything typed is still
  // unsaved work. Returning false here let "New document" wipe a fully typed
  // document with no prompt.
  it("treats typed content with nothing stored as unsaved work", () => {
    expect(isDocumentDirty({ ...stored, title: "Anything" }, null)).toBe(true);
    expect(isDocumentDirty({ ...stored, title: "", body_md: "# Draft" }, null)).toBe(true);
  });

  it("is clean when nothing is stored and nothing has been typed", () => {
    expect(isDocumentDirty({ ...stored, title: "", body_md: "" }, null)).toBe(false);
    expect(isDocumentDirty({ ...stored, title: "   ", body_md: "  " }, null)).toBe(false);
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
    expect(wideningVisibility("members", "public")).toEqual({ from: "members", to: "public" });
    expect(wideningVisibility("managers", "public")).toEqual({ from: "managers", to: "public" });
  });

  // Taking a document away from people is recoverable and unsurprising.
  it("does not flag a narrowing change", () => {
    expect(wideningVisibility("public", "members")).toBeNull();
    expect(wideningVisibility("members", "managers")).toBeNull();
  });

  it("does not flag an unchanged visibility, or a brand-new document", () => {
    expect(wideningVisibility("members", "members")).toBeNull();
    expect(wideningVisibility(null, "public")).toBeNull();
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
