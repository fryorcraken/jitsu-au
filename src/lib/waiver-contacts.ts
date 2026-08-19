// Who the club can contact about a participant, and how.
//
// A waiver names up to two people beyond the participant, and for a minor they
// are not always the same one:
//
//   * the **parent or legal guardian**, who signs and carries the liability;
//   * the **emergency contact**, who we ring if something happens in class.
//
// The form used to treat those as one person for a minor: the guardian columns
// were filled from whatever was typed in the emergency contact block, so a
// family where the aunt does the pickup had to choose which of the two people
// to write down. Now the guardian is asked for in their own right, with their
// own address, mobile and email -- each of which is optional on the form,
// meaning "the same as the participant's".
//
// So the value that gets stored has to be worked out from the raw inputs, and
// that has to happen in exactly one place: the live document preview, the
// "you still have to fill this in" checklist and the server all have to agree
// on what was signed. This module is that place. Pure and server-import-free,
// so it is unit-testable on its own.

/** The raw form inputs this resolves. Every field is as typed, untrimmed. */
export type WaiverContactInput = {
  /** Under 18 on the day of signing; false means no guardian at all. */
  isMinor: boolean;
  /** The participant's own details, which the guardian's fall back to. */
  address: string;
  phone: string;
  email: string;
  guardianName: string;
  guardianRelationship: string;
  /** Blank means "the same as the participant's". */
  guardianAddress: string;
  guardianPhone: string;
  guardianEmail: string;
  /**
   * The common case, and the form's default for a minor: the person we ring in
   * an emergency IS the guardian who signed, so we do not ask for them twice.
   * Ignored for an adult, who has no guardian to copy.
   */
  emergencyContactIsGuardian: boolean;
  emergencyContactName: string;
  emergencyContactRelationship: string;
  emergencyContactPhone: string;
};

/** What actually gets stored and printed. Guardian fields are "" for an adult. */
export type ResolvedWaiverContacts = {
  guardianName: string;
  guardianRelationship: string;
  guardianAddress: string;
  guardianPhone: string;
  guardianEmail: string;
  emergencyContactName: string;
  emergencyContactRelationship: string;
  emergencyContactPhone: string;
};

const t = (value: string | null | undefined) => (value ?? "").trim();

/**
 * Resolve the two contacts from the raw inputs.
 *
 * A blank guardian address / mobile / email takes the participant's, and the
 * resolved value is what is stored -- not the blank. A manager reading a
 * waiver a year later should not have to work out which empty fields once
 * meant "same as above", and the participant's own details can change
 * afterwards while the frozen submission must not.
 *
 * The guardian's name and relationship fall back to the emergency contact for
 * the same reason in reverse: a paper form filed from the old single-block
 * layout has only that one person written on it, and they are the person who
 * signed it. The online form always asks for the guardian by name, so the
 * fallback never fires there.
 */
export function resolveWaiverContacts(v: WaiverContactInput): ResolvedWaiverContacts {
  const emergency = {
    emergencyContactName: t(v.emergencyContactName),
    emergencyContactRelationship: t(v.emergencyContactRelationship),
    emergencyContactPhone: t(v.emergencyContactPhone),
  };

  if (!v.isMinor) {
    return {
      guardianName: "",
      guardianRelationship: "",
      guardianAddress: "",
      guardianPhone: "",
      guardianEmail: "",
      ...emergency,
    };
  }

  const guardianName = t(v.guardianName) || emergency.emergencyContactName;
  const guardianRelationship = t(v.guardianRelationship) || emergency.emergencyContactRelationship;
  const guardianAddress = t(v.guardianAddress) || t(v.address);
  const guardianPhone = t(v.guardianPhone) || t(v.phone);
  const guardianEmail = t(v.guardianEmail) || t(v.email);

  return {
    guardianName,
    guardianRelationship,
    guardianAddress,
    guardianPhone,
    guardianEmail,
    ...(v.emergencyContactIsGuardian
      ? {
          emergencyContactName: guardianName,
          emergencyContactRelationship: guardianRelationship,
          emergencyContactPhone: guardianPhone,
        }
      : emergency),
  };
}
