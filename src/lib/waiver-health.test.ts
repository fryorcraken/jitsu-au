import { describe, expect, it } from "vitest";
import {
  anyHealthConcern,
  buildHealthPlaceholders,
  healthQuestions,
  missingHealthAnswers,
  NOT_ANSWERED,
} from "./waiver-health";
import { healthQuestionIds } from "./validation";

const allNo = { drugs: false, blackouts: false, device: false, impairments: false, other: false };

describe("healthQuestions", () => {
  // The schema is what the server enforces; this list is what the form asks and
  // the document prints. A question added to one and not the other would ask
  // something nobody validates, or validate something nobody was asked.
  it("covers exactly the ids the submission schema requires", () => {
    expect(healthQuestions.map((q) => q.id)).toEqual(healthQuestionIds);
  });

  it("asks each question once, as a question", () => {
    for (const q of healthQuestions) {
      expect(q.question.endsWith("?")).toBe(true);
    }
    expect(new Set(healthQuestions.map((q) => q.id)).size).toBe(healthQuestions.length);
  });
});

describe("missingHealthAnswers", () => {
  it("is empty once every question is answered", () => {
    expect(missingHealthAnswers(allNo)).toEqual([]);
  });

  it("reports a question that has not been answered", () => {
    const { drugs: _unanswered, ...rest } = allNo;
    expect(missingHealthAnswers(rest).map((q) => q.id)).toEqual(["drugs"]);
  });

  // The form starts with every answer null, and a null must never pass for a
  // "no": nobody has declared anything yet.
  it("treats an explicit null as unanswered", () => {
    expect(missingHealthAnswers({ ...allNo, device: null }).map((q) => q.id)).toEqual(["device"]);
  });

  it("reports every unanswered question, not just the first", () => {
    expect(missingHealthAnswers({}).map((q) => q.id)).toEqual(healthQuestionIds);
  });
});

describe("anyHealthConcern", () => {
  it("is false when nothing is declared", () => {
    expect(anyHealthConcern(allNo)).toBe(false);
    expect(anyHealthConcern({})).toBe(false);
  });

  it("is true as soon as one question is answered yes", () => {
    expect(anyHealthConcern({ ...allNo, blackouts: true })).toBe(true);
  });
});

describe("buildHealthPlaceholders", () => {
  it("renders one Yes/No token per question", () => {
    const values = buildHealthPlaceholders({ ...allNo, impairments: true });
    expect(values.health_drugs).toBe("No");
    expect(values.health_impairments).toBe("Yes");
    expect(Object.keys(values)).toEqual(healthQuestionIds.map((id) => `health_${id}`));
  });

  // Only reachable in the live preview, where the signer has not worked down
  // the list yet. It must never read as a "No" they did not give.
  it("marks an unanswered question as not answered", () => {
    expect(buildHealthPlaceholders({}).health_other).toBe(NOT_ANSWERED);
    expect(buildHealthPlaceholders({ other: null }).health_other).toBe(NOT_ANSWERED);
  });
});
