import { describe, expect, it } from "vitest";
import {
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
