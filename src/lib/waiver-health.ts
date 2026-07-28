// The health declaration on the application form: the five safety questions and
// the pure helpers that ask, check and print them.
//
// The wording lives here so the signing form and the signed document ask the
// same question in the same words. The answers are yes/no only: anything the
// signer needs to explain goes in the one medical-details field the form has
// always had (`medical_notes`), which is required as soon as any answer is yes.
//
// Nothing here is stored in a column. Like the acknowledgement ticks, the
// answers are evidence and live inside the signed PDF (see docs/waivers.md).
// Kept side-effect-free and server-import-free so it stays unit-testable.
import { healthQuestionIds, type HealthQuestionId } from "./validation";

export type HealthQuestion = {
  id: HealthQuestionId;
  /** The question, as asked on the form and printed on the document. */
  question: string;
};

/** The five questions, in the order the form asks them. */
export const healthQuestions: HealthQuestion[] = [
  {
    id: "drugs",
    question:
      "Is the participant prescribed any drugs which may impair reaction time or judgement?",
  },
  {
    id: "blackouts",
    question:
      "Has the participant, within the past 5 years, suffered any blackout, seizure, convulsion, fainting or dizzy spells, or any incapacity that would render it unsafe to participate in martial arts?",
  },
  {
    id: "device",
    question: "Is the participant fitted with any electronic device or shunt?",
  },
  {
    id: "impairments",
    question:
      "Does the participant have any current physical impairment, injuries or medical conditions (for example back injuries, weak ankles)?",
  },
  {
    id: "other",
    question:
      "Is there any other medical information or health needs our instructors should be aware of for the participant's safety?",
  },
];

/** Answers while the form is being filled in: `null` = not answered yet. */
export type HealthAnswerDraft = Partial<Record<HealthQuestionId, boolean | null>>;

/** Shown on the document for a question nobody answered. */
export const NOT_ANSWERED = "Not answered";

/**
 * Questions still unanswered, for the form's submit guard. The server enforces
 * the same rule through `healthAnswersSchema`; this is what lets the form say
 * so before a round trip.
 */
export function missingHealthAnswers(answers: HealthAnswerDraft): HealthQuestion[] {
  return healthQuestions.filter((q) => typeof answers[q.id] !== "boolean");
}

/**
 * True when any question was answered yes. That is what makes the medical
 * details field required: a "yes" the signer never explained tells an
 * instructor nothing.
 */
export function anyHealthConcern(answers: HealthAnswerDraft): boolean {
  return healthQuestions.some((q) => answers[q.id] === true);
}

/**
 * The `{{health_*}}` tokens a template body can use, one per question, e.g.
 * `{{health_drugs}}` -> "Yes" / "No" / "Not answered" (the last only reachable
 * in the live preview, before the signer has worked down the list).
 */
export function buildHealthPlaceholders(answers: HealthAnswerDraft): Record<string, string> {
  const values: Record<string, string> = {};
  for (const id of healthQuestionIds) {
    const answer = answers[id];
    values[`health_${id}`] = typeof answer === "boolean" ? (answer ? "Yes" : "No") : NOT_ANSWERED;
  }
  return values;
}
