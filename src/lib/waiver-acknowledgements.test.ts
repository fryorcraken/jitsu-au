import { describe, expect, it } from "vitest";
import {
  MEDIA_ACK_ID,
  mediaConsentFromAnswers,
  mediaConsentLabel,
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
