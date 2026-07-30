import { describe, it, expect } from "vitest";
import {
  ACTIVATE_UTS_CODE_URL,
  CODE_OF_CONDUCT_BODY_MD,
  CODE_OF_CONDUCT_VERSION,
  buildCodeOfConductUrl,
  codeOfConductState,
  latestAcceptedVersion,
  parseCodeOfConductBlocks,
  parseCodeOfConductSpans,
} from "./code-of-conduct";

describe("the document", () => {
  it("opens with a heading and covers every section the club published", () => {
    const blocks = parseCodeOfConductBlocks(CODE_OF_CONDUCT_BODY_MD);
    expect(blocks[0]).toEqual({ kind: "h1", text: "UTS Jitsu Code of Conduct" });

    const headings = blocks.filter((b) => b.kind === "h2").map((b) => (b as { text: string }).text);
    expect(headings).toEqual([
      "Health and hygiene",
      "Jewellery and piercings",
      "Mat etiquette",
      "Protective equipment",
      "Grading and uniform",
      "Respect, inclusion and training safety",
      "Reporting incidents",
      "Coaching standards",
      "Breaches of this Code",
    ]);
  });

  it("links the ActivateUTS code, which this one sits on top of", () => {
    expect(CODE_OF_CONDUCT_BODY_MD).toContain(ACTIVATE_UTS_CODE_URL);
  });

  it("keeps the rules people are most likely to be told off for", () => {
    // Not an exhaustive re-transcription: these are the specific rules that
    // would be quietly lost in an edit and only noticed on the mat.
    expect(CODE_OF_CONDUCT_BODY_MD).toContain("cough into your gi lapel");
    expect(CODE_OF_CONDUCT_BODY_MD).toContain("Mouthguard");
    expect(CODE_OF_CONDUCT_BODY_MD).toContain("light blue grades or above");
    expect(CODE_OF_CONDUCT_BODY_MD).toContain("Working with Children Check");
  });

  it("uses no em dashes, per the house writing style", () => {
    expect(CODE_OF_CONDUCT_BODY_MD).not.toContain("—");
  });
});

describe("parseCodeOfConductBlocks", () => {
  it("reads headings, paragraphs and bullet lists", () => {
    const blocks = parseCodeOfConductBlocks(
      "# Title\n\n## Section\n\nIntro line:\n- one\n- two\n\nAfter.",
    );
    expect(blocks).toEqual([
      { kind: "h1", text: "Title" },
      { kind: "h2", text: "Section" },
      { kind: "p", text: "Intro line:" },
      { kind: "ul", items: ["one", "two"] },
      { kind: "p", text: "After." },
    ]);
  });

  it("keeps a paragraph's own line breaks", () => {
    expect(parseCodeOfConductBlocks("first\nsecond")).toEqual([
      { kind: "p", text: "first\nsecond" },
    ]);
  });

  it("drops blank blocks rather than rendering empty paragraphs", () => {
    expect(parseCodeOfConductBlocks("\n\n   \n\n")).toEqual([]);
  });
});

describe("parseCodeOfConductSpans", () => {
  it("marks bold runs", () => {
    expect(parseCodeOfConductSpans("**Sick? Stay home.** Do not train.")).toEqual([
      { kind: "bold", text: "Sick? Stay home." },
      { kind: "text", text: " Do not train." },
    ]);
  });

  it("links a bare URL without swallowing the sentence's full stop", () => {
    const spans = parseCodeOfConductSpans(`See ${ACTIVATE_UTS_CODE_URL}.`);
    expect(spans).toEqual([
      { kind: "text", text: "See " },
      // The trailing slash is part of the URL; the full stop after it is not.
      { kind: "link", text: ACTIVATE_UTS_CODE_URL, href: ACTIVATE_UTS_CODE_URL },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves plain text alone", () => {
    expect(parseCodeOfConductSpans("Bow when stepping onto the mat.")).toEqual([
      { kind: "text", text: "Bow when stepping onto the mat." },
    ]);
  });
});

describe("codeOfConductState", () => {
  it("is unsigned when nothing was ever agreed to", () => {
    expect(codeOfConductState(null)).toBe("unsigned");
    expect(codeOfConductState(undefined)).toBe("unsigned");
  });

  it("is signed for the current version", () => {
    expect(codeOfConductState(2, 2)).toBe("signed");
  });

  it("is outdated once the club publishes a newer version", () => {
    expect(codeOfConductState(1, 2)).toBe("outdated");
  });

  /**
   * A version ahead of the current one still counts as signed. It happens
   * during a rollback, and telling somebody who agreed to the NEWER text that
   * they are out of date would be nonsense.
   */
  it("treats a version ahead of the current one as signed", () => {
    expect(codeOfConductState(3, 2)).toBe("signed");
  });

  it("defaults to the version shipped in this build", () => {
    expect(codeOfConductState(CODE_OF_CONDUCT_VERSION)).toBe("signed");
    expect(codeOfConductState(CODE_OF_CONDUCT_VERSION - 1)).toBe("outdated");
  });
});

describe("latestAcceptedVersion", () => {
  it("is null when there are no acceptances", () => {
    expect(latestAcceptedVersion([])).toBeNull();
    expect(latestAcceptedVersion(null)).toBeNull();
  });

  /**
   * The HIGHEST version, not the most recent row. Re-signing an old version
   * after a new one is not a downgrade, and reading "latest" as "newest by
   * date" would send somebody a re-read prompt for text they have already
   * agreed to.
   */
  it("takes the highest version, not the last one recorded", () => {
    expect(latestAcceptedVersion([{ version: 3 }, { version: 1 }, { version: 2 }])).toBe(3);
  });
});

describe("buildCodeOfConductUrl", () => {
  it("is root-relative when no site is given", () => {
    expect(buildCodeOfConductUrl({})).toBe("/code-of-conduct");
  });

  it("carries the token for a link that arrives by email", () => {
    expect(buildCodeOfConductUrl({ siteUrl: "https://jitsu.au/", token: "abc def" })).toBe(
      "https://jitsu.au/code-of-conduct?t=abc%20def",
    );
  });

  it("omits the query when there is no token", () => {
    expect(buildCodeOfConductUrl({ siteUrl: "https://jitsu.au", token: null })).toBe(
      "https://jitsu.au/code-of-conduct",
    );
  });
});
