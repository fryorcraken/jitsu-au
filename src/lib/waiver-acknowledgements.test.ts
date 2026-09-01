import { describe, expect, it } from "vitest";
import {
  MEDIA_ACK_ID,
  mediaConsentFromAnswers,
  mediaConsentLabel,
  mediaConsentProvenance,
  missingRequiredAcks,
  parseTemplateAcks,
  resolveAcknowledgements,
  type TemplateAcknowledgement,
} from "./waiver-acknowledgements";

const defs: TemplateAcknowledgement[] = [
  { id: "risk", label: "I accept the risks.", required: true },
  { id: "release", label: "I release {{club_name}}.", required: true },
  { id: "media", label: "I consent to media.", required: false },
];

describe("parseTemplateAcks", () => {
  it("keeps valid entries and drops malformed ones", () => {
    const parsed = parseTemplateAcks([
      { id: "a", label: "Valid", required: true },
      { id: "b", label: "", required: true }, // empty label -> invalid
      { id: "c", required: false }, // missing label -> invalid
      "nope", // wrong type
    ]);
    expect(parsed).toEqual([{ id: "a", label: "Valid", required: true }]);
  });

  it("returns [] for non-array input", () => {
    expect(parseTemplateAcks(null)).toEqual([]);
    expect(parseTemplateAcks(undefined)).toEqual([]);
    expect(parseTemplateAcks({})).toEqual([]);
  });
});

describe("missingRequiredAcks", () => {
  it("returns required acks that are not accepted", () => {
    const missing = missingRequiredAcks(defs, { risk: true, media: true });
    expect(missing.map((a) => a.id)).toEqual(["release"]);
  });

  it("ignores optional acks and passes when all required are accepted", () => {
    expect(missingRequiredAcks(defs, { risk: true, release: true })).toEqual([]);
  });

  it("treats missing/false answers as not accepted", () => {
    expect(missingRequiredAcks(defs, { risk: false }).map((a) => a.id)).toEqual([
      "risk",
      "release",
    ]);
  });
});

describe("resolveAcknowledgements", () => {
  it("flattens defs + answers into label/checked pairs, leaving tokens intact", () => {
    expect(resolveAcknowledgements(defs, { risk: true, media: false })).toEqual([
      { label: "I accept the risks.", checked: true },
      { label: "I release {{club_name}}.", checked: false },
      { label: "I consent to media.", checked: false },
    ]);
  });
});

describe("mediaConsentFromAnswers", () => {
  it("reads the tick when the template asks", () => {
    expect(mediaConsentFromAnswers(defs, { media: true })).toBe(true);
  });

  it("is false when the template asks and the signer left it unticked", () => {
    expect(mediaConsentFromAnswers(defs, { risk: true })).toBe(false);
    expect(mediaConsentFromAnswers(defs, { media: false })).toBe(false);
  });

  // The distinction the whole three-state design exists for: a template with no
  // media item never asked, and recording that as `false` would put a refusal
  // the club never received onto every waiver signed before the question
  // existed — and hide the people who still need asking.
  it("is null when the template has no media acknowledgement", () => {
    const noMedia = defs.filter((d) => d.id !== MEDIA_ACK_ID);
    expect(mediaConsentFromAnswers(noMedia, { media: true })).toBeNull();
    expect(mediaConsentFromAnswers([], {})).toBeNull();
  });

  it("ignores a non-boolean answer rather than trusting it", () => {
    expect(mediaConsentFromAnswers(defs, { media: "yes" as unknown as boolean })).toBe(false);
  });
});

describe("mediaConsentLabel", () => {
  it("names all three states, never blanking the unasked one", () => {
    expect(mediaConsentLabel(true)).toBe("Yes");
    expect(mediaConsentLabel(false)).toBe("No");
    expect(mediaConsentLabel(null)).toBe("Not asked");
    expect(mediaConsentLabel(undefined)).toBe("Not asked");
  });
});

describe("mediaConsentProvenance", () => {
  const base = {
    userId: "child-1",
    guardianUserId: "parent-1",
    guardianName: "Ada Lovelace",
    updatedAt: "2 Feb 2026, 9:00 am",
    value: false,
  };

  it("names the guardian when the guardian answered, not the club", () => {
    // The bug this exists to stop. A parent answering for their nine-year-old
    // is not the subject either, so a bare `setBy !== userId` reads their
    // decision as one a manager made, on the page a manager checks before
    // publishing a photograph.
    expect(mediaConsentProvenance({ ...base, setBy: "parent-1" })).toBe(
      "Set on 2 Feb 2026, 9:00 am by Ada Lovelace who holds their account.",
    );
  });

  it("still says a manager when it really was a manager", () => {
    expect(mediaConsentProvenance({ ...base, setBy: "manager-9" })).toBe(
      "Set by a manager on 2 Feb 2026, 9:00 am, not read off a waiver.",
    );
  });

  it("says a person set their own, even when they are on somebody's account", () => {
    // An adult can be on a household without being a dependant, and a member
    // who signs up their own children is on nobody's.
    expect(mediaConsentProvenance({ ...base, setBy: "child-1" })).toBe(
      "They set this themselves on 2 Feb 2026, 9:00 am, from their account page.",
    );
    expect(mediaConsentProvenance({ ...base, guardianUserId: null, setBy: "child-1" })).toBe(
      "They set this themselves on 2 Feb 2026, 9:00 am, from their account page.",
    );
  });

  it("falls back to a manager when there is no guardian to be", () => {
    expect(mediaConsentProvenance({ ...base, guardianUserId: null, setBy: "someone-else" })).toBe(
      "Set by a manager on 2 Feb 2026, 9:00 am, not read off a waiver.",
    );
  });

  it("still attributes it to the guardian when their name did not load", () => {
    // A failed name lookup must not silently promote the sentence back to
    // "a manager", which is the one thing it is not.
    expect(mediaConsentProvenance({ ...base, guardianName: null, setBy: "parent-1" })).toBe(
      "Set on 2 Feb 2026, 9:00 am by the person who holds their account.",
    );
  });

  it("separates an answer off a waiver from never having been asked", () => {
    expect(mediaConsentProvenance({ ...base, setBy: null })).toBe("From their approved waiver.");
    expect(mediaConsentProvenance({ ...base, setBy: null, value: null })).toBe(
      "Nothing recorded yet.",
    );
  });
});
