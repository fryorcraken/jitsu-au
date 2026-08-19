// What the waiver form is still waiting on, in the order it asks for it.
//
// The signing form used to answer "you missed something" in two different
// voices. The plain text inputs carried the browser's own `required` attribute,
// so a missing name got a native bubble on one field and whatever scrolling the
// browser felt like; everything the browser cannot check (the five health
// answers, the acknowledgement ticks, the signature) got a toast that named one
// problem at a time and then faded. Someone with three things left blank found
// out about them one press at a time, and on a phone the toast was often gone
// before they had finished scrolling.
//
// So the form does its own checking, and this module is the whole rule: one
// ordered list of what is missing, computed from the form's state, with the id
// of the control to jump to for each entry. The order IS the form's reading
// order, top to bottom, which is what makes "jump to the first one" mean the
// first one a person would have filled in.
//
// It deliberately mirrors `waiverSubmitSchema` in `validation.ts` rather than
// replacing it: the server is still the thing that decides whether a waiver may
// be filed. This exists so the signer hears it in their own words, before a
// round trip, instead of as a Zod issue dump.
//
// Kept side-effect-free and server-import-free so it stays unit-testable.
import { z } from "zod";
import { anyHealthConcern, missingHealthAnswers, type HealthAnswerDraft } from "./waiver-health";
import {
  missingRequiredAcks,
  type AcknowledgementAnswers,
  type TemplateAcknowledgement,
} from "./waiver-acknowledgements";

/** One thing the signer still has to do before the form can be sent. */
export type MissingWaiverField = {
  /**
   * The `id` of the element to scroll to and focus. Every entry has one, which
   * is what lets the summary list double as a set of jump links.
   */
  anchorId: string;
  /** What it is called, in the same words as the label on the form. */
  label: string;
  /** How to satisfy it, when "fill this in" is not the whole story. */
  hint?: string;
};

/** The form's state, as far as "is this fillable in" is concerned. */
export type WaiverFieldState = {
  firstName: string;
  lastName: string;
  dob: string;
  phone: string;
  email: string;
  address: string;
  ecName: string;
  ecRelationship: string;
  ecPhone: string;
  /** Under 18, and the emergency contact is the guardian: the form asked for
   * that person once, so the three fields above are not on screen to fill in. */
  ecIsGuardian: boolean;
  guardianName: string;
  guardianRelationship: string;
  health: HealthAnswerDraft;
  medical: string;
  /** The current template's acknowledgements, labels already substituted. */
  ackDefs: TemplateAcknowledgement[];
  acks: AcknowledgementAnswers;
  signatureMode: "draw" | "type";
  signatureName: string;
  signatureImage: string;
  isMinor: boolean;
  guardianSignatureMode: "draw" | "type";
  guardianSignature: string;
  guardianSignatureImage: string;
};

/** The dom id of an acknowledgement's tick box. */
export const ackAnchorId = (id: string) => `ack_${id}`;

/**
 * The ids of the two signature blocks, invented here rather than being a
 * field's own name. The form puts them on the elements, so both sides read them
 * from this one place: an id that only matched by convention would come apart
 * silently, as a jump that goes nowhere and a field that is never marked, with
 * nothing in a typecheck or a test to notice.
 */
export const WAIVER_ANCHORS = {
  signaturePad: "signature_field",
  signatureName: "signature_name",
  guardianPad: "guardian_signature_field",
  guardianName: "guardian_signature_name",
} as const;

/** Where the signature block jumps to, which depends on how they are signing. */
export const signatureAnchorId = (mode: "draw" | "type") =>
  mode === "type" ? WAIVER_ANCHORS.signatureName : WAIVER_ANCHORS.signaturePad;

/** Same, for the parent/guardian block shown for a participant under 18. */
export const guardianSignatureAnchorId = (mode: "draw" | "type") =>
  mode === "type" ? WAIVER_ANCHORS.guardianName : WAIVER_ANCHORS.guardianPad;

// Same rule the submission schema applies, so the form cannot wave through an
// address the server will reject. The form's own `maxLength` caps the length.
const emailField = z.string().trim().email();

/** An acknowledgement label is a whole sentence; the summary shows the start. */
function shorten(label: string, max = 70): string {
  const text = label.trim();
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}

/**
 * Everything the signer still has to do, top to bottom.
 *
 * Empty means the form is ready to send. The first entry is the one to jump to.
 */
export function missingWaiverFields(state: WaiverFieldState): MissingWaiverField[] {
  const missing: MissingWaiverField[] = [];
  const require = (anchorId: string, label: string, value: string) => {
    if (!value.trim()) missing.push({ anchorId, label });
  };

  // ---- Your details ----
  require("first_name", "First name", state.firstName);
  require("last_name", "Last name", state.lastName);
  require("date_of_birth", "Date of birth", state.dob);
  require("phone", "Phone", state.phone);
  if (!state.email.trim()) {
    missing.push({ anchorId: "email", label: "Email" });
  } else if (!emailField.safeParse(state.email).success) {
    // Listed with the missing fields on purpose: to the person filling the form
    // these are the same problem, "this one is not right yet". Dropping the
    // browser's native checking is what makes it ours to report.
    missing.push({
      anchorId: "email",
      label: "Email",
      hint: "Check the address, it should look like name@example.com",
    });
  }
  require("address", "Address", state.address);

  // ---- Parent or guardian (minors only) ----
  //
  // The guardian's address, mobile and email are deliberately absent: each is
  // optional and means "the same as the participant's", so there is nothing
  // there for somebody to have missed.
  if (state.isMinor) {
    require("guardian_name", "Parent or guardian name", state.guardianName);
    require("guardian_relationship", "Parent or guardian relationship to the participant", state.guardianRelationship);
  }

  // ---- Emergency contact ----
  //
  // Skipped entirely when it is the guardian above: those fields are not on
  // screen, so listing them would send somebody to a control they cannot see.
  if (!(state.isMinor && state.ecIsGuardian)) {
    require("emergency_contact_name", "Emergency contact name", state.ecName);
    require("emergency_contact_relationship", "Emergency contact relationship", state.ecRelationship);
    require("emergency_contact_phone", "Emergency contact mobile", state.ecPhone);
  }

  // ---- Health declaration ----
  for (const question of missingHealthAnswers(state.health)) {
    missing.push({
      anchorId: `${question.id}_yes`,
      label: `Health question: ${question.shortLabel}`,
      hint: "Answer yes or no",
    });
  }
  if (anyHealthConcern(state.health) && !state.medical.trim()) {
    missing.push({
      anchorId: "medical_notes",
      label: "Details of anything you answered yes to",
    });
  }

  // ---- Acknowledgements ----
  for (const ack of missingRequiredAcks(state.ackDefs, state.acks)) {
    missing.push({
      anchorId: ackAnchorId(ack.id),
      label: shorten(ack.label),
      hint: "Please read this and tick it",
    });
  }

  // ---- Signature ----
  const signature = state.signatureMode === "draw" ? state.signatureImage : state.signatureName;
  if (!signature.trim()) {
    missing.push({
      anchorId: signatureAnchorId(state.signatureMode),
      label: "Your signature",
      hint: "Draw it or type your full name",
    });
  }
  if (state.isMinor) {
    const guardian =
      state.guardianSignatureMode === "draw"
        ? state.guardianSignatureImage
        : state.guardianSignature;
    if (!guardian.trim()) {
      missing.push({
        anchorId: guardianSignatureAnchorId(state.guardianSignatureMode),
        label: "Parent or guardian signature",
        hint: "A parent or guardian signs for participants under 18",
      });
    }
  }

  return missing;
}

/**
 * The heading over the summary. Counted, because "3 things" tells someone at a
 * glance whether they are one tick or half a form away from signing.
 */
export function missingFieldsSummary(count: number): string {
  return count === 1
    ? "One thing is missing before you can sign"
    : `${count} things are missing before you can sign`;
}
