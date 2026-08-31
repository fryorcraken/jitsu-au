// How a screen refers to the person it is about. Small, but it decides the
// wording of every account card, and getting it wrong means a parent reads
// "photos or video of you" above their nine-year-old's consent answer.
import { describe, expect, it } from "vitest";
import { firstWord, subjectVoice } from "./subject-voice";

describe("subjectVoice", () => {
  it("speaks second person about the reader themselves", () => {
    expect(subjectVoice(null)).toEqual({
      who: "you",
      whose: "your",
      Whose: "Your",
      isSelf: true,
    });
  });

  it("names somebody else, and possesses their name", () => {
    expect(subjectVoice("Bea")).toEqual({
      who: "Bea",
      whose: "Bea's",
      Whose: "Bea's",
      isSelf: false,
    });
  });

  it("treats a blank name as the reader, not as somebody called nothing", () => {
    // A profile that has not loaded, or a person with no first name on file.
    // Second person is the safe answer: it is never wrong ABOUT anyone, where
    // "'s waiver history" is visibly broken.
    for (const blank of ["", "   ", null, undefined]) {
      expect(subjectVoice(blank).isSelf).toBe(true);
      expect(subjectVoice(blank).who).toBe("you");
    }
  });

  it("adds a plain 's to a name ending in s", () => {
    // "Chris's" is the standard form, and a rule that special-cased it would
    // get "James'" wrong as often as right.
    expect(subjectVoice("Chris").whose).toBe("Chris's");
  });

  it("trims, so a stray space does not become part of the possessive", () => {
    expect(subjectVoice("  Bea  ").whose).toBe("Bea's");
  });
});

describe("firstWord", () => {
  it("takes the first name off a full name", () => {
    expect(firstWord("Bea Lovelace")).toBe("Bea");
  });

  it("strips the quotes nameWithPreferred puts round a preferred name", () => {
    // `nameWithPreferred` renders `Ada "Addy" Lovelace`, and a page that said
    // `"Addy"'s membership` would print the quotes mid-sentence.
    expect(firstWord('"Addy" Lovelace')).toBe("Addy");
  });

  it("returns null for nothing, so a caller falls back to second person", () => {
    expect(firstWord("")).toBeNull();
    expect(firstWord(null)).toBeNull();
    expect(firstWord("   ")).toBeNull();
  });
});
