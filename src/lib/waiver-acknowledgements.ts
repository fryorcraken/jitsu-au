// Pure helpers for the template-defined waiver acknowledgements. Kept
// side-effect-free and server-import-free so they stay unit-testable and can be
// shared by the signing form, the server handler, and the renderers.
import { acknowledgementDefSchema, type AcknowledgementDef } from "./validation";

export type TemplateAcknowledgement = AcknowledgementDef;

/** Accepted state keyed by acknowledgement id. */
export type AcknowledgementAnswers = Record<string, boolean>;

/**
 * The one acknowledgement id the app reads by name.
 *
 * Every other acknowledgement is opaque to the code: managers add, reword and
 * delete them freely at /manager/waiver-template and the only thing that
 * happens is a different line in the PDF. This one also lands in
 * `waivers.media_consent` and `profiles.media_consent`, because the club needs
 * to answer "can we photograph this person" without opening a PDF.
 *
 * That makes the id load-bearing: the template editor refuses to delete or
 * rename it (the wording stays editable, and so does whether it is required),
 * so a routine template edit cannot quietly disconnect consent capture. If it
 * is ever missing from a template anyway, `mediaConsentFromAnswers` returns
 * null -- "not asked" -- rather than a false that would read as a refusal.
 */
export const MEDIA_ACK_ID = "media";

/**
 * The media-consent answer a submission carries, as stored on the waiver row.
 *
 * `null` when the signed template had no media acknowledgement at all, which is
 * every waiver signed before that item existed. Only a template that actually
 * asked can produce a true or a false.
 */
export function mediaConsentFromAnswers(
  defs: TemplateAcknowledgement[],
  answers: AcknowledgementAnswers,
): boolean | null {
  if (!defs.some((d) => d.id === MEDIA_ACK_ID)) return null;
  return answers[MEDIA_ACK_ID] === true;
}

/**
 * How a media-consent value reads on screen.
 *
 * "Not asked" rather than a dash or a blank: null is a real answer about the
 * club's records -- this person still needs asking -- and a manager scanning
 * the page should be able to act on it.
 */
export function mediaConsentLabel(value: boolean | null | undefined): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Not asked";
}

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
