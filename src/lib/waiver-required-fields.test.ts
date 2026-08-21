import { describe, expect, it } from "vitest";
import {
  ackAnchorId,
  missingFieldsSummary,
  missingWaiverFields,
  type WaiverFieldState,
} from "./waiver-required-fields";
import { healthQuestions } from "./waiver-health";

const allAnswered = {
  drugs: false,
  blackouts: false,
  device: false,
  impairments: false,
  other: false,
};

/** A form with nothing filled in, i.e. what a first-time signer starts from. */
const emptyForm: WaiverFieldState = {
  firstName: "",
  lastName: "",
  dob: "",
  phone: "",
  email: "",
  address: "",
  ecName: "",
  ecRelationship: "",
  ecPhone: "",
  ecIsGuardian: false,
  guardianName: "",
  guardianRelationship: "",
  guardianEmail: "",
  health: {},
  medical: "",
  ackDefs: [],
  acks: {},
  signatureMode: "draw",
  signatureName: "",
  signatureImage: "",
  isMinor: false,
  guardianSignatureMode: "draw",
  guardianSignature: "",
  guardianSignatureImage: "",
};

/** A form that is ready to send: every required field filled, signed by hand. */
const completeForm: WaiverFieldState = {
  ...emptyForm,
  firstName: "Sam",
  lastName: "Nguyen",
  dob: "1995-04-02",
  phone: "0400 000 000",
  email: "sam@example.com",
  address: "1 Broadway, Ultimo NSW 2007",
  ecName: "Alex Nguyen",
  ecRelationship: "Partner",
  ecPhone: "0400 111 111",
  health: allAnswered,
  signatureImage: "data:image/png;base64,AAAA",
};

const form = (over: Partial<WaiverFieldState> = {}): WaiverFieldState => ({
  ...completeForm,
  ...over,
});

describe("missingWaiverFields", () => {
  it("is empty for a form that is ready to send", () => {
    expect(missingWaiverFields(completeForm)).toEqual([]);
  });

  // The whole point of the list: one press of Sign names everything that is
  // outstanding, not just the first thing the browser happened to notice.
  it("names every outstanding field at once, not one at a time", () => {
    const missing = missingWaiverFields(emptyForm);
    expect(missing.length).toBeGreaterThan(10);
    expect(missing.map((f) => f.label)).toContain("First name");
    expect(missing.map((f) => f.label)).toContain("Your signature");
  });

  // The order is what "jump to the first missing field" means. Reading order,
  // top to bottom, so the first entry is the one nearest the top of the page.
  it("lists fields in the order the form asks for them", () => {
    const missing = missingWaiverFields(emptyForm).map((f) => f.anchorId);
    expect(missing).toEqual([
      "first_name",
      "last_name",
      "date_of_birth",
      "phone",
      "email",
      "address",
      "emergency_contact_name",
      "emergency_contact_relationship",
      "emergency_contact_phone",
      ...healthQuestions.map((q) => `${q.id}_yes`),
      "signature_field",
    ]);
  });

  it("puts a missing field further down the form after the ones above it", () => {
    const missing = missingWaiverFields(form({ address: "", ecPhone: "" }));
    expect(missing.map((f) => f.anchorId)).toEqual(["address", "emergency_contact_phone"]);
  });

  it("treats whitespace as blank", () => {
    const missing = missingWaiverFields(form({ firstName: "   " }));
    expect(missing.map((f) => f.anchorId)).toEqual(["first_name"]);
  });

  it("gives every entry an anchor and a label", () => {
    for (const field of missingWaiverFields(emptyForm)) {
      expect(field.anchorId).toBeTruthy();
      expect(field.label).toBeTruthy();
    }
  });

  // The form drops the browser's own checking (one bubble, on one field), so an
  // address that is present but not an address has to be caught here or it
  // reaches the server and comes back as a Zod issue.
  it("flags an email that is filled in but is not an email address", () => {
    const missing = missingWaiverFields(form({ email: "sam.example.com" }));
    expect(missing).toHaveLength(1);
    expect(missing[0].anchorId).toBe("email");
    expect(missing[0].hint).toBeTruthy();
  });

  it("accepts an email with surrounding whitespace", () => {
    expect(missingWaiverFields(form({ email: "  sam@example.com  " }))).toEqual([]);
  });

  describe("health declaration", () => {
    it("lists each unanswered question separately, in the order asked", () => {
      const missing = missingWaiverFields(form({ health: { drugs: true, device: false } }));
      expect(missing.map((f) => f.anchorId)).toEqual([
        "blackouts_yes",
        "impairments_yes",
        "other_yes",
        // The "yes" to drugs is what makes the details box required.
        "medical_notes",
      ]);
    });

    it("names a question in a few words rather than repeating the sentence", () => {
      const [first] = missingWaiverFields(form({ health: {} }));
      expect(first.label).toBe("Health question: prescribed drugs");
    });

    it("requires the details box once anything is answered yes", () => {
      const yes = { ...allAnswered, impairments: true };
      expect(missingWaiverFields(form({ health: yes })).map((f) => f.anchorId)).toEqual([
        "medical_notes",
      ]);
      expect(missingWaiverFields(form({ health: yes, medical: "Sore left knee" }))).toEqual([]);
    });

    it("leaves the details box optional when every answer is no", () => {
      expect(missingWaiverFields(form({ health: allAnswered, medical: "" }))).toEqual([]);
    });
  });

  describe("acknowledgements", () => {
    const ackDefs = [
      { id: "risk", label: "I accept the risks of training.", required: true },
      { id: "media", label: "Photos of me may be used.", required: false },
    ];

    it("lists a required acknowledgement that has not been ticked", () => {
      const missing = missingWaiverFields(form({ ackDefs, acks: {} }));
      expect(missing.map((f) => f.anchorId)).toEqual([ackAnchorId("risk")]);
      expect(missing[0].label).toBe("I accept the risks of training.");
    });

    it("ignores an optional acknowledgement", () => {
      expect(missingWaiverFields(form({ ackDefs, acks: { risk: true } }))).toEqual([]);
    });

    it("shortens a long acknowledgement so the summary stays readable", () => {
      const long = "I ".padEnd(200, "acknowledge and agree ");
      const [entry] = missingWaiverFields(
        form({ ackDefs: [{ id: "long", label: long, required: true }], acks: {} }),
      );
      expect(entry.label.length).toBeLessThanOrEqual(73);
      expect(entry.label.endsWith("...")).toBe(true);
    });
  });

  describe("signature", () => {
    it("points at the pad when they are drawing", () => {
      const missing = missingWaiverFields(form({ signatureMode: "draw", signatureImage: "" }));
      expect(missing.map((f) => f.anchorId)).toEqual(["signature_field"]);
    });

    it("points at the name box when they are typing", () => {
      const missing = missingWaiverFields(
        form({ signatureMode: "type", signatureName: "", signatureImage: "" }),
      );
      expect(missing.map((f) => f.anchorId)).toEqual(["signature_name"]);
    });

    // Only the active tab counts, the same way only the active tab is sent.
    it("does not accept a drawing while the typed tab is showing", () => {
      const missing = missingWaiverFields(
        form({ signatureMode: "type", signatureName: "", signatureImage: "data:image/png;x" }),
      );
      expect(missing.map((f) => f.anchorId)).toEqual(["signature_name"]);
    });

    it("accepts a typed name", () => {
      expect(
        missingWaiverFields(form({ signatureMode: "type", signatureName: "Sam Nguyen" })),
      ).toEqual([]);
    });
  });

  describe("participant under 18", () => {
    /** A minor's form with the guardian named, as the page requires. */
    const minorForm = (over: Partial<WaiverFieldState> = {}): WaiverFieldState =>
      form({
        isMinor: true,
        guardianName: "Kim Nguyen",
        guardianRelationship: "Mother",
        guardianSignatureImage: "data:image/png;base64,BBBB",
        ...over,
      });

    // The guardian is named on the document and signs it, so both are asked for
    // before the emergency contact, which is where the form asks for them.
    it("asks for the guardian's name and relationship", () => {
      const missing = missingWaiverFields(
        minorForm({ guardianName: "", guardianRelationship: "" }),
      );
      expect(missing.map((f) => f.anchorId)).toEqual(["guardian_name", "guardian_relationship"]);
    });

    // Blank means "the same as the participant's", so there is nothing missing.
    it("never asks for the guardian's address, mobile or email", () => {
      expect(missingWaiverFields(minorForm())).toEqual([]);
    });

    // Optional, but an address that WAS typed still has to be one the server
    // accepts: `waiverSubmitSchema` rejects a malformed guardian email, and the
    // point of this module is that the signer hears that here, not as a Zod
    // dump after a round trip.
    it("flags a malformed guardian email, but not a blank one", () => {
      expect(missingWaiverFields(minorForm({ guardianEmail: "" }))).toEqual([]);
      expect(missingWaiverFields(minorForm({ guardianEmail: "  " }))).toEqual([]);
      expect(missingWaiverFields(minorForm({ guardianEmail: "kim@example.com" }))).toEqual([]);

      const missing = missingWaiverFields(minorForm({ guardianEmail: "kim@" }));
      expect(missing.map((f) => f.anchorId)).toEqual(["guardian_email"]);
      expect(missing[0].hint).toMatch(/name@example\.com/);
    });

    // The guardian block is off screen for an adult, so pointing somebody at a
    // control they cannot see would be worse than saying nothing. The page
    // stops sending the value at the same time, so the server agrees.
    it("ignores a stale guardian email once the date of birth says adult", () => {
      expect(missingWaiverFields(form({ isMinor: false, guardianEmail: "kim@" }))).toEqual([]);
    });

    // The three emergency contact fields are off screen when the guardian is
    // the contact, so listing them would point at controls that are not there.
    it("skips the emergency contact when it is the guardian", () => {
      expect(
        missingWaiverFields(
          minorForm({ ecIsGuardian: true, ecName: "", ecRelationship: "", ecPhone: "" }),
        ),
      ).toEqual([]);
      const missing = missingWaiverFields(
        minorForm({ ecIsGuardian: false, ecName: "", ecRelationship: "", ecPhone: "" }),
      );
      expect(missing.map((f) => f.anchorId)).toEqual([
        "emergency_contact_name",
        "emergency_contact_relationship",
        "emergency_contact_phone",
      ]);
    });

    it("asks for a guardian signature, after the applicant's own", () => {
      const missing = missingWaiverFields(
        minorForm({ signatureImage: "", guardianSignatureImage: "" }),
      );
      expect(missing.map((f) => f.anchorId)).toEqual([
        "signature_field",
        "guardian_signature_field",
      ]);
    });

    it("points at the guardian name box when the guardian is typing", () => {
      const missing = missingWaiverFields(
        minorForm({ guardianSignatureMode: "type", guardianSignatureImage: "" }),
      );
      expect(missing.map((f) => f.anchorId)).toEqual(["guardian_signature_name"]);
    });

    it("is satisfied by a guardian signature", () => {
      expect(missingWaiverFields(minorForm())).toEqual([]);
    });

    it("asks for nothing extra from an adult", () => {
      expect(missingWaiverFields(form({ isMinor: false }))).toEqual([]);
    });
  });
});

describe("missingFieldsSummary", () => {
  it("counts, so the signer knows how far off they are", () => {
    expect(missingFieldsSummary(1)).toBe("One thing is missing before you can sign");
    expect(missingFieldsSummary(4)).toBe("4 things are missing before you can sign");
  });
});
