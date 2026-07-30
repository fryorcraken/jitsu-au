/**
 * Pure helpers for rendering a waiver as HTML (see
 * `src/components/site/WaiverDocument.tsx`). Kept server-import-free and
 * side-effect-free so they stay unit-testable.
 */
import { buildHealthPlaceholders, type HealthAnswerDraft } from "./waiver-health";

export type WaiverBlock =
  | { kind: "hr" }
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string }
  | { kind: "checklist"; items: { checked: boolean; text: string }[] };

/** A single `{{adult_checkbox}} Adult (18+)`-style line, once substituted. */
const CHECKBOX_LINE = /^\[([ xX])\]\s+(.+)$/;

/**
 * If every non-blank line in a paragraph is a `[X] label` / `[ ] label` line
 * (what `{{adult_checkbox}}`-style tokens substitute to), parse it as a
 * checklist instead of a plain paragraph. Returns null for an ordinary
 * paragraph, including one that merely happens to start with a bracket.
 */
export function matchChecklistLines(block: string): { checked: boolean; text: string }[] | null {
  const lines = block.split("\n").map((l) => l.trim());
  const items: { checked: boolean; text: string }[] = [];
  for (const line of lines) {
    if (!line) continue;
    const m = CHECKBOX_LINE.exec(line);
    if (!m) return null;
    items.push({ checked: m[1].toLowerCase() === "x", text: m[2] });
  }
  return items.length > 0 ? items : null;
}

/**
 * Parse the template body the same way the PDF renderer does
 * (`src/lib/waiver-pdf.ts`): split on blank lines, then recognise `---`, `# `,
 * `## `, `[X]`/`[ ]` checklist lines, and plain paragraphs.
 *
 * A single newline inside a paragraph is kept as a line break (the PDF wraps
 * each line separately, and the HTML renders the text pre-line). The document
 * is a form: "Full name: ..." and "Date of birth: ..." on consecutive lines
 * must stay on consecutive lines, not run together into one sentence.
 */
export function parseWaiverBlocks(body: string): WaiverBlock[] {
  const blocks: WaiverBlock[] = [];
  for (const raw of body.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    const checklist = matchChecklistLines(block);
    if (block === "---") {
      blocks.push({ kind: "hr" });
    } else if (block.startsWith("# ")) {
      blocks.push({ kind: "h1", text: block.slice(2) });
    } else if (block.startsWith("## ")) {
      blocks.push({ kind: "h2", text: block.slice(3) });
    } else if (checklist) {
      blocks.push({ kind: "checklist", items: checklist });
    } else {
      blocks.push({ kind: "p", text: block });
    }
  }
  return blocks;
}

/** Waiver field values used to fill `{{placeholder}}` tokens in the body. */
export type WaiverPlaceholderInput = {
  fullName: string;
  /** First name, the fallback for `{{preferred_name}}`. */
  firstName: string;
  /** Optional preferred name; `{{preferred_name}}` falls back to the first name. */
  preferredName: string;
  dateOfBirth: string;
  address: string;
  phone: string;
  email: string;
  emergencyContactName: string;
  /** How the emergency contact is related; the "relationship to minor" too. */
  emergencyContactRelationship: string;
  emergencyContactPhone: string;
  medicalNotes: string;
  /** The five health answers; unanswered ones render as "Not answered". */
  healthAnswers: HealthAnswerDraft;
  signatureName: string;
  clubName: string;
  /** Under 18: ticks the minor box and fills the guardian tokens. */
  isMinor: boolean;
  /** Pre-formatted signing date for `{{signed_date}}` (empty string if unsigned). */
  signedDate: string;
};

/**
 * Ticked / unticked box, in characters the PDF's standard font can encode.
 * Both renderers recognise a `[X] label` / `[ ] label` line (via
 * `matchChecklistLines`) and draw it as an actual checkbox glyph, never this
 * literal bracket text.
 */
const TICKED = "[X]";
const UNTICKED = "[ ]";

/**
 * Map waiver field values to the `{{token}}` names used in template bodies.
 * The names match the placeholder chips in the waiver-template editor.
 */
export function buildWaiverPlaceholders(v: WaiverPlaceholderInput): Record<string, string> {
  return {
    full_name: v.fullName,
    // The one rule the whole app uses for "what do we call this person":
    // the preferred name if they gave one, else their first name (see
    // `greetingName`). A template that greets the signer must never render a
    // blank, so the full name is a last resort for the half-filled live
    // preview. Trimmed because this runs on raw form state in the preview but
    // on Zod-trimmed input server-side, and the two must render identically.
    preferred_name: v.preferredName.trim() || v.firstName.trim() || v.fullName,
    date_of_birth: v.dateOfBirth,
    address: v.address,
    phone: v.phone,
    email: v.email,
    emergency_contact_name: v.emergencyContactName,
    emergency_contact_relationship: v.emergencyContactRelationship,
    emergency_contact_phone: v.emergencyContactPhone,
    medical_notes: v.medicalNotes || "None provided",
    ...buildHealthPlaceholders(v.healthAnswers),
    // The participant-type boxes at the top of the form: exactly one is ticked,
    // from the date of birth the signer gave.
    adult_checkbox: v.isMinor ? UNTICKED : TICKED,
    minor_checkbox: v.isMinor ? TICKED : UNTICKED,
    // For a minor the guardian IS the emergency contact, so the guardian tokens
    // read off that one block rather than a second copy of the same person.
    guardian_name: v.isMinor ? v.emergencyContactName : "N/A",
    guardian_relationship: v.isMinor ? v.emergencyContactRelationship : "N/A",
    signature_name: v.signatureName || v.fullName,
    signed_date: v.signedDate,
    club_name: v.clubName,
  };
}

/**
 * Does the body actually print any of these `{{tokens}}`?
 *
 * The health answers are evidence with no column behind them: the signed
 * document is their only record. If the current template does not reference
 * them — the version live before this form shipped does not, and a manager can
 * always delete a token — they would be collected and then vanish. Both
 * renderers use this to fall back to a section of their own.
 */
export function bodyReferences(body: string, tokens: string[]): boolean {
  return tokens.some((token) => new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`).test(body));
}

/**
 * Replace `{{placeholder}}` tokens in a template body with the given values.
 * Unknown tokens are left intact so authoring mistakes stay visible.
 */
export function applyWaiverPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in values ? values[k] : `{{${k}}}`));
}
