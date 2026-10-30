import { beforeEach, describe, expect, it } from "vitest";
import {
  WAIVER_DRAFT_KEY,
  WAIVER_DRAFT_MAX_BYTES,
  WAIVER_DRAFT_VERSION,
  clearDraft,
  draftHasContent,
  parseDraft,
  readDraft,
  serializeDraft,
  writeDraft,
  type WaiverDraft,
} from "./waiver-draft";
import { EMPTY_ADDRESS } from "./au-address";

const blank: WaiverDraft = {
  submissionId: "3f7c1a2e-9b4d-4c8a-8e21-5d6f0a1b2c3d",
  signingFor: "self",
  firstName: "",
  middleName: "",
  lastName: "",
  preferredName: "",
  dob: "",
  phone: "",
  email: "",
  address: EMPTY_ADDRESS,
  addressOnFile: "",
  utsStudentNumber: "",
  smsConsent: false,
  giSize: "",
  martialArtsExperience: "",
  ecName: "",
  ecRelationship: "",
  ecPhone: "",
  ecIsGuardian: true,
  guardianName: "",
  guardianRelationship: "",
  guardianSameAddress: true,
  guardianAddress: EMPTY_ADDRESS,
  guardianAddressOnFile: "",
  guardianPhone: "",
  guardianEmail: "",
  health: { drugs: null, blackouts: null, device: null, impairments: null, other: null },
  medical: "",
  acks: {},
  signatureMode: "draw",
  signatureName: "",
  signatureImage: "",
  guardianSignatureMode: "draw",
  guardianSignature: "",
  guardianSignatureImage: "",
};

const filled: WaiverDraft = {
  ...blank,
  firstName: "Ada",
  lastName: "Lovelace",
  dob: "1990-12-10",
  phone: "0400000000",
  email: "ada@example.com",
  address: {
    ...EMPTY_ADDRESS,
    street: "1 Broadway",
    suburb: "Ultimo",
    state: "NSW",
    postcode: "2007",
  },
  smsConsent: true,
  giSize: "4",
  martialArtsExperience: "2 years BJJ",
  ecName: "Charles Babbage",
  ecRelationship: "Colleague",
  ecPhone: "0400000001",
  health: { drugs: false, blackouts: false, device: false, impairments: true, other: false },
  medical: "Weak left ankle",
  acks: { read: true, voluntary: true },
  signatureMode: "draw",
  signatureImage: "data:image/png;base64,AAAA",
};

beforeEach(() => {
  sessionStorage.clear();
});

describe("serializeDraft / parseDraft", () => {
  it("round-trips every field", () => {
    expect(parseDraft(serializeDraft(filled))).toEqual(filled);
  });

  it("discards a draft written by an older version", () => {
    // Half-restoring an old shape silently drops whatever was renamed, and the
    // person has no way to tell. Starting clean is the honest failure.
    const stale = JSON.stringify({ ...filled, version: WAIVER_DRAFT_VERSION - 1 });
    expect(parseDraft(stale)).toBeNull();
  });

  it("restores a draft saved before an optional field existed, rather than binning it", () => {
    // `giSize` was added without bumping the version, on purpose. A draft that
    // predates it is not a stale shape: the field is optional, and restoring it
    // as "" says exactly what is true, that nobody chose a size. Bumping would
    // have thrown away every half-filled waiver, signature included, over a
    // field none of them had.
    const { giSize: _omitted, ...withoutGiSize } = filled;
    const older = JSON.stringify({ ...withoutGiSize, version: WAIVER_DRAFT_VERSION });
    const restored = parseDraft(older);
    expect(restored).not.toBeNull();
    expect(restored?.giSize).toBe("");
    expect(restored?.firstName).toBe("Ada");
    expect(restored?.signatureImage).toBe(filled.signatureImage);
  });

  it("restores a draft saved before martialArtsExperience existed, rather than binning it", () => {
    // Same reasoning as the giSize case above: added without a version bump.
    const { martialArtsExperience: _omitted, ...withoutExperience } = filled;
    const older = JSON.stringify({ ...withoutExperience, version: WAIVER_DRAFT_VERSION });
    const restored = parseDraft(older);
    expect(restored).not.toBeNull();
    expect(restored?.martialArtsExperience).toBe("");
    expect(restored?.firstName).toBe("Ada");
  });

  it("ignores malformed or empty storage", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("")).toBeNull();
    expect(parseDraft("{not json")).toBeNull();
    expect(parseDraft("[]")).toBeNull();
    expect(parseDraft(JSON.stringify({ version: WAIVER_DRAFT_VERSION }))).toBeNull();
  });

  it("drops the signature images rather than exceeding the size guard", () => {
    // A signature takes seconds to redraw; the twenty fields around it do not.
    // Throwing QuotaExceededError inside a keystroke handler would lose both.
    const huge = "data:image/png;base64," + "A".repeat(WAIVER_DRAFT_MAX_BYTES);
    const restored = parseDraft(
      serializeDraft({ ...filled, signatureImage: huge, guardianSignatureImage: huge }),
    );

    expect(restored?.signatureImage).toBe("");
    expect(restored?.guardianSignatureImage).toBe("");
    expect(restored?.firstName).toBe("Ada");
    expect(restored?.medical).toBe("Weak left ankle");
    expect(restored?.health.impairments).toBe(true);
  });

  it("keeps the submission id, so a reload mid-submit can ask instead of resend", () => {
    // The whole reason the id lives in the draft: after a reload the page can
    // check whether that submission landed rather than signing a second waiver.
    expect(parseDraft(serializeDraft(filled))?.submissionId).toBe(filled.submissionId);
  });

  it("coerces junk values instead of restoring them", () => {
    const junk = JSON.stringify({
      ...filled,
      firstName: 42,
      smsConsent: "yes",
      signatureMode: "scribble",
      health: { drugs: "maybe", blackouts: true },
      acks: { read: "true", voluntary: true },
      version: WAIVER_DRAFT_VERSION,
    });
    const restored = parseDraft(junk);

    expect(restored?.firstName).toBe("");
    expect(restored?.smsConsent).toBe(false);
    expect(restored?.signatureMode).toBe("draw");
    expect(restored?.health).toEqual({ drugs: null, blackouts: true });
    expect(restored?.acks).toEqual({ voluntary: true });
  });
});

describe("draftHasContent", () => {
  it("is false for a draft that only carries its submission id", () => {
    // A draft is written the moment the page mounts, so offering to restore one
    // on a first visit would be pure noise.
    expect(draftHasContent(blank)).toBe(false);
    expect(draftHasContent(null)).toBe(false);
  });

  it("is true once anything has been typed or answered", () => {
    expect(draftHasContent({ ...blank, firstName: "Ada" })).toBe(true);
    expect(draftHasContent({ ...blank, signatureImage: "data:image/png;base64,AA" })).toBe(true);
    expect(draftHasContent({ ...blank, health: { ...blank.health, drugs: false } })).toBe(true);
  });

  it("does not count whitespace as content", () => {
    expect(draftHasContent({ ...blank, firstName: "   " })).toBe(false);
  });
});

describe("readDraft / writeDraft / clearDraft", () => {
  it("persists to sessionStorage and reads back", () => {
    writeDraft(filled);
    expect(sessionStorage.getItem(WAIVER_DRAFT_KEY)).toBeTruthy();
    expect(readDraft()).toEqual(filled);
  });

  it("uses sessionStorage, so nothing is left in localStorage", () => {
    // The draft holds health answers and a signature. Surviving a reload is the
    // requirement; surviving the browser closing on a shared machine is not.
    writeDraft(filled);
    expect(localStorage.getItem(WAIVER_DRAFT_KEY)).toBeNull();
  });

  it("clears cleanly and reads null afterwards", () => {
    writeDraft(filled);
    clearDraft();
    expect(readDraft()).toBeNull();
  });

  it("returns null rather than throwing on leftover junk", () => {
    sessionStorage.setItem(WAIVER_DRAFT_KEY, "{not json");
    expect(readDraft()).toBeNull();
  });
});

describe("addresses in a draft", () => {
  it("keeps the parts of both addresses across a reload", () => {
    const draft: WaiverDraft = {
      ...filled,
      guardianSameAddress: false,
      guardianAddress: {
        ...EMPTY_ADDRESS,
        street: "9 Quay St",
        suburb: "Haymarket",
        state: "",
        postcode: "20",
      },
    };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("reads a draft written before addresses had parts, without binning it", () => {
    const old = JSON.parse(serializeDraft(filled));
    old.address = "1 Broadway, Ultimo NSW 2007";
    old.guardianAddress = "9 Quay St, Haymarket NSW 2000";
    delete old.guardianSameAddress;
    const restored = parseDraft(JSON.stringify(old));
    expect(restored?.address).toMatchObject({
      street: "1 Broadway",
      suburb: "Ultimo",
      state: "NSW",
      postcode: "2007",
    });
    expect(restored?.guardianSameAddress).toBe(false);
    expect(restored?.guardianAddress.suburb).toBe("Haymarket");
  });

  it("restores an old one-line address it cannot split as empty boxes", () => {
    const old = JSON.parse(serializeDraft(filled));
    old.address = "1 Broadway Ultimo";
    old.guardianAddress = "";
    delete old.guardianSameAddress;
    const restored = parseDraft(JSON.stringify(old));
    expect(restored?.address).toEqual(EMPTY_ADDRESS);
    // ...but not lost: the page shows it above the boxes to copy from.
    expect(restored?.addressOnFile).toBe("1 Broadway Ultimo");
    expect(restored?.guardianSameAddress).toBe(true);
    // The rest of the form is still there.
    expect(restored?.firstName).toBe("Ada");
  });

  it("drops a state the form does not offer", () => {
    const stored = JSON.parse(serializeDraft(filled));
    stored.address.state = "XYZ";
    expect(parseDraft(JSON.stringify(stored))?.address.state).toBe("");
  });
});

describe("an address outside Australia in a draft", () => {
  it("keeps the tick, the free-text state and the country across a reload", () => {
    const draft: WaiverDraft = {
      ...filled,
      address: {
        overseas: true,
        street: "10 Downing St",
        suburb: "London",
        state: "England",
        postcode: "SW1A 2AA",
        country: "United Kingdom",
      },
    };
    expect(parseDraft(serializeDraft(draft))?.address).toEqual(draft.address);
  });
});
