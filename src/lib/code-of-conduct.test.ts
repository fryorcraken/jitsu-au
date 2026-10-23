import { describe, it, expect } from "vitest";
import {
  buildCodeOfConductUrl,
  codeOfConductStandard,
  codeOfConductState,
  codeOfConductSummary,
  countReprompted,
  requiredVersionForSave,
  isSignableVersion,
  latestAcceptedVersion,
  parseCodeOfConductBlocks,
  parseCodeOfConductSpans,
  standardAfterPublishing,
  standardAfterSaving,
} from "./code-of-conduct";
import { VERSION_1_BODY_MD as CODE_OF_CONDUCT_BODY_MD } from "./code-of-conduct-version-1.fixture";

const ACTIVATE_UTS_CODE_URL =
  "https://www.activateuts.com.au/terms-conditions/club-code-of-conduct/";

// The text members agreed to as version 1, read through the renderer the public
// page uses. Later versions are whatever managers write; these pin the parser
// against the one text every existing acceptance names.
describe("version 1 of the document", () => {
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
    expect(codeOfConductState(null, 2)).toBe("unsigned");
    expect(codeOfConductState(undefined, 2)).toBe("unsigned");
  });

  it("is signed at or above the version the club last asked everybody to agree to", () => {
    expect(codeOfConductState(2, 2)).toBe("signed");
    expect(codeOfConductState(3, 2)).toBe("signed");
  });

  it("is outdated below it", () => {
    expect(codeOfConductState(1, 2)).toBe("outdated");
  });

  it("counts any agreement when nothing was ever asked", () => {
    expect(codeOfConductState(1, null)).toBe("signed");
  });
});

describe("isSignableVersion", () => {
  it("files a signature against the live version the person was shown", () => {
    expect(isSignableVersion(3, { current_version: 3, required_version: 1 })).toBe(true);
  });

  // A manager published while they read: what they agreed to is not the
  // club's text any more, and recording the new number would claim they read
  // words they never saw.
  it("refuses the version a page was showing once a newer one is live", () => {
    expect(isSignableVersion(2, { current_version: 3, required_version: 3 })).toBe(false);
  });

  it("refuses everything when nothing is live", () => {
    expect(isSignableVersion(1, { current_version: null, required_version: null })).toBe(false);
  });
});

describe("codeOfConductStandard", () => {
  const v = (version: number, required_version: number, is_current = false) => ({
    version,
    asks_reagreement: required_version === version,
    required_version,
    is_current,
  });

  it("requires what the live version requires", () => {
    expect(codeOfConductStandard([v(1, 1), v(2, 1), v(3, 3, true)])).toEqual({
      current_version: 3,
      required_version: 3,
    });
  });

  // The whole point of the choice: fixing a typo publishes a new version
  // without moving what anybody has to have agreed to.
  it("does not move the requirement for a version published without asking", () => {
    expect(codeOfConductStandard([v(1, 1), v(2, 1, true)])).toEqual({
      current_version: 2,
      required_version: 1,
    });
  });

  it("has nothing to measure against when nothing is live", () => {
    expect(codeOfConductStandard([v(1, 1)])).toEqual({
      current_version: null,
      required_version: null,
    });
  });
});

describe("requiredVersionForSave", () => {
  const live4 = [
    { version: 2, asks_reagreement: true, required_version: 2, is_current: false },
    { version: 4, asks_reagreement: false, required_version: 2, is_current: true },
  ];

  it("requires itself when it asks", () => {
    expect(requiredVersionForSave(5, true, live4)).toBe(5);
  });

  it("keeps what the live version requires when it does not", () => {
    expect(requiredVersionForSave(5, false, live4)).toBe(2);
  });

  // A failed promotion can leave the club with nothing live. A correction saved
  // to fix that must not put every member out of date, which inheriting from
  // "nothing" as if nothing had ever been asked would do.
  it("inherits the newest version's requirement when nothing is live", () => {
    const nothingLive = live4.map((v) => ({ ...v, is_current: false }));
    expect(requiredVersionForSave(5, false, nothingLive)).toBe(2);
  });

  it("is the baseline when nothing is stored at all", () => {
    expect(requiredVersionForSave(1, false, [])).toBe(1);
  });
});

describe("what a publish does to people", () => {
  const versions = [
    { version: 1, asks_reagreement: true, required_version: 1, is_current: false },
    { version: 2, asks_reagreement: false, required_version: 1, is_current: true },
  ];
  const now = codeOfConductStandard(versions);
  // Three people agreed to 1, one to 2.
  const highest = [1, 1, 1, 2];

  it("re-prompts nobody for a version saved without asking", () => {
    expect(countReprompted(highest, now, standardAfterSaving(versions, false))).toBe(0);
  });

  it("re-prompts everybody who is up to date for a version that asks", () => {
    const after = standardAfterSaving(versions, true);
    expect(after).toEqual({ current_version: 3, required_version: 3 });
    expect(countReprompted(highest, now, after)).toBe(4);
  });

  it("does not count somebody who was already out of date", () => {
    const asked = [
      { version: 1, asks_reagreement: true, required_version: 1, is_current: false },
      { version: 2, asks_reagreement: true, required_version: 2, is_current: true },
    ];
    const before = codeOfConductStandard(asked);
    expect(countReprompted([1, 2], before, standardAfterSaving(asked, true))).toBe(1);
  });

  it("re-prompts nobody when rolling back below the ask", () => {
    const asked = [
      { version: 1, asks_reagreement: true, required_version: 1, is_current: false },
      { version: 2, asks_reagreement: true, required_version: 2, is_current: true },
    ];
    const before = codeOfConductStandard(asked);
    const after = standardAfterPublishing(asked, 1);
    expect(after).toEqual({ current_version: 1, required_version: 1 });
    expect(countReprompted([1, 2], before, after)).toBe(0);
  });

  // The failure a rule derived from "the newest version that asked" had: roll
  // back from a rewrite that asked, save a typo fix, and the rolled-back ask
  // came back the moment the typo fix's number passed it.
  it("keeps a rolled-back ask undone when a correction is saved afterwards", () => {
    const rolledBack = [
      { version: 4, asks_reagreement: false, required_version: 1, is_current: true },
      { version: 5, asks_reagreement: true, required_version: 5, is_current: false },
    ];
    const before = codeOfConductStandard(rolledBack);
    const after = standardAfterSaving(rolledBack, false);
    expect(after).toEqual({ current_version: 6, required_version: 1 });
    expect(countReprompted([1, 4], before, after)).toBe(0);
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

describe("codeOfConductSummary", () => {
  const row = (version: number, accepted_at: string, signature_name = "Ada Lovelace") => ({
    version,
    accepted_at,
    signature_name,
  });

  it("reports nobody who has never agreed as unsigned, with nothing else to say", () => {
    expect(codeOfConductSummary([], { current_version: 2, required_version: 2 })).toEqual({
      state: "unsigned",
      current_version: 2,
      required_version: 2,
      accepted_version: null,
      accepted_at: null,
      signature_name: null,
    });
    expect(codeOfConductSummary(null, { current_version: 2, required_version: 2 }).state).toBe(
      "unsigned",
    );
  });

  it("is decided by the highest version, not the latest row", () => {
    const summary = codeOfConductSummary(
      [row(1, "2026-03-01T00:00:00Z", "Ada L"), row(2, "2026-02-01T00:00:00Z")],
      { current_version: 2, required_version: 2 },
    );
    expect(summary).toMatchObject({
      state: "signed",
      accepted_version: 2,
      accepted_at: "2026-02-01T00:00:00Z",
      signature_name: "Ada Lovelace",
    });
  });

  it("keeps the first row given on a tie, which is the newest when read newest first", () => {
    const summary = codeOfConductSummary(
      [row(1, "2026-03-01T00:00:00Z", "Second"), row(1, "2026-01-01T00:00:00Z", "First")],
      { current_version: 1, required_version: 1 },
    );
    expect(summary.signature_name).toBe("Second");
  });

  it("says outdated when the highest version agreed to is behind what the club asked for", () => {
    expect(
      codeOfConductSummary([row(1, "2026-01-01T00:00:00Z")], {
        current_version: 2,
        required_version: 2,
      }).state,
    ).toBe("outdated");
  });

  // A typo-fix version is live, but nobody was asked to agree to it again.
  it("stays signed behind a live version that did not ask", () => {
    expect(
      codeOfConductSummary([row(1, "2026-01-01T00:00:00Z")], {
        current_version: 2,
        required_version: 1,
      }).state,
    ).toBe("signed");
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
