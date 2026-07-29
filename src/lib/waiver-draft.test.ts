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

const blank: WaiverDraft = {
  submissionId: "3f7c1a2e-9b4d-4c8a-8e21-5d6f0a1b2c3d",
  firstName: "",
  middleName: "",
  lastName: "",
  preferredName: "",
  dob: "",
  phone: "",
  email: "",
  address: "",
  utsStudentNumber: "",
  smsConsent: false,
  ecName: "",
  ecRelationship: "",
  ecPhone: "",
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
  address: "1 Broadway, Ultimo NSW",
  smsConsent: true,
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
