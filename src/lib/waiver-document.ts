/**
 * Pure helpers for rendering a waiver as HTML (see
 * `src/components/site/WaiverDocument.tsx`). Kept server-import-free and
 * side-effect-free so they stay unit-testable.
 */

export type WaiverBlock =
  | { kind: "hr" }
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string };

/**
 * Parse the template body the same way the PDF renderer does
 * (`src/lib/waiver-pdf.ts`): split on blank lines, then recognise `---`, `# `,
 * `## `, and plain paragraphs. Single newlines inside a paragraph collapse to
 * spaces, matching the PDF.
 */
export function parseWaiverBlocks(body: string): WaiverBlock[] {
  const blocks: WaiverBlock[] = [];
  for (const raw of body.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (block === "---") {
      blocks.push({ kind: "hr" });
    } else if (block.startsWith("# ")) {
      blocks.push({ kind: "h1", text: block.slice(2) });
    } else if (block.startsWith("## ")) {
      blocks.push({ kind: "h2", text: block.slice(3) });
    } else {
      blocks.push({ kind: "p", text: block.replace(/\n/g, " ") });
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
  emergencyContactPhone: string;
  medicalNotes: string;
  signatureName: string;
  clubName: string;
  /** Pre-formatted signing date for `{{signed_date}}` (empty string if unsigned). */
  signedDate: string;
};

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
    emergency_contact_phone: v.emergencyContactPhone,
    medical_notes: v.medicalNotes || "None provided",
    signature_name: v.signatureName || v.fullName,
    signed_date: v.signedDate,
    club_name: v.clubName,
  };
}

/**
 * Replace `{{placeholder}}` tokens in a template body with the given values.
 * Unknown tokens are left intact so authoring mistakes stay visible.
 */
export function applyWaiverPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in values ? values[k] : `{{${k}}}`));
}
