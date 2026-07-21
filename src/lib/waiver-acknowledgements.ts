// Pure helpers for the template-defined waiver acknowledgements. Kept
// side-effect-free and server-import-free so they stay unit-testable and can be
// shared by the signing form, the server handler, and the renderers.
import { acknowledgementDefSchema, type AcknowledgementDef } from "./validation";

export type TemplateAcknowledgement = AcknowledgementDef;

/** Accepted state keyed by acknowledgement id. */
export type AcknowledgementAnswers = Record<string, boolean>;

/**
 * Parse the `acknowledgements` JSONB off a template row into a typed list.
 * Invalid entries are dropped rather than failing the whole read, and any
 * non-array value yields `[]` — the generated Supabase types don't yet know the
 * column, so this is the trust boundary.
 */
export function parseTemplateAcks(value: unknown): TemplateAcknowledgement[] {
  if (!Array.isArray(value)) return [];
  const out: TemplateAcknowledgement[] = [];
  for (const item of value) {
    const parsed = acknowledgementDefSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Required acknowledgements the signer has not accepted. */
export function missingRequiredAcks(
  defs: TemplateAcknowledgement[],
  answers: AcknowledgementAnswers,
): TemplateAcknowledgement[] {
  return defs.filter((d) => d.required && answers[d.id] !== true);
}

/**
 * Flatten template defs + accepted answers into the render list used by the
 * HTML document and the PDF. Labels keep their raw `{{tokens}}`; the renderers
 * substitute them alongside the body.
 */
export function resolveAcknowledgements(
  defs: TemplateAcknowledgement[],
  answers: AcknowledgementAnswers,
): { label: string; checked: boolean }[] {
  return defs.map((d) => ({ label: d.label, checked: answers[d.id] === true }));
}
