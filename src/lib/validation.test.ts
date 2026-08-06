import { describe, expect, it } from "vitest";
import {
  attachCheckInSchema,
  blockCommenterSchema,
  blogCommentSchema,
  blogPostSchema,
  buildSignerMeta,
  cancelEventSchema,
  checkInSchema,
  checkInWarnings,
  codeOfConductAcceptSchema,
  commentDisplayName,
  composeFullName,
  contactSchema,
  coverageSources,
  createAnnotationSchema,
  kbSlugSchema,
  resolveAnnotationSchema,
  saveKbArticleSchema,
  saveKbSectionSchema,
  updateAnnotationSchema,
  undoCheckInSchema,
  createCalendarEntrySchema,
  rsvpSchema,
  updateCalendarEntrySchema,
  decodeDataUrlPng,
  deriveExpandedWaivers,
  deriveWaiverListStatuses,
  interestSchema,
  isFutureSigningDate,
  isMinorOn,
  isPaperWaiver,
  isUtsStudent,
  managerEmailChangeSchema,
  MAX_SCAN_BYTES,
  base64ByteLength,
  normalizeEmail,
  nextUtcDay,
  paperWaiverUploadSchema,
  profileFullName,
  resolveNamePrefill,
  saveTemplateSchema,
  setCurrentTemplateSchema,
  splitFullName,
  stopRepeatingSchema,
  updateMyProfileSchema,
  managerKitSizesSchema,
  waiverApprovalSchema,
  waiverPrefillSearchSchema,
  greetingName,
  nameWithPreferred,
  waiverSubmitSchema,
  waiverToProfileFields,
} from "./validation";

describe("profileFullName", () => {
  it("composes from name parts, tolerating nulls", () => {
    expect(profileFullName({ first_name: "Ada", middle_name: null, last_name: "Lovelace" })).toBe(
      "Ada Lovelace",
    );
    expect(profileFullName({ first_name: "Ada", middle_name: "M", last_name: "Lovelace" })).toBe(
      "Ada M Lovelace",
    );
    expect(profileFullName({ first_name: "Grace" })).toBe("Grace");
    expect(profileFullName({})).toBe("");
  });
});

describe("greetingName", () => {
  it("prefers the preferred name", () => {
    expect(greetingName({ preferred_name: "Addy", first_name: "Ada", last_name: "Lovelace" })).toBe(
      "Addy",
    );
  });

  it("falls back to the first name when no preferred name was given", () => {
    expect(greetingName({ preferred_name: null, first_name: "Ada", last_name: "Lovelace" })).toBe(
      "Ada",
    );
    expect(greetingName({ preferred_name: "   ", first_name: "Ada", last_name: "Lovelace" })).toBe(
      "Ada",
    );
  });

  it("falls back to the full name when there is no first name", () => {
    expect(greetingName({ first_name: null, middle_name: "Byron", last_name: "Lovelace" })).toBe(
      "Byron Lovelace",
    );
  });

  it("is empty when the profile carries no name at all", () => {
    expect(greetingName({})).toBe("");
  });
});

describe("nameWithPreferred", () => {
  it("quotes the preferred name into the conventional nickname position", () => {
    expect(
      nameWithPreferred({
        first_name: "Ada",
        middle_name: "Byron",
        last_name: "Lovelace",
        preferred_name: "Addy",
      }),
    ).toBe('Ada "Addy" Byron Lovelace');
  });

  it("returns the plain full name when no preferred name was given", () => {
    expect(
      nameWithPreferred({ first_name: "Ada", last_name: "Lovelace", preferred_name: null }),
    ).toBe("Ada Lovelace");
  });

  // Repeating the first name adds nothing, so it is left off rather than
  // rendering the noisy `Ada "Ada" Lovelace`.
  it("omits a preferred name that just repeats the first name, ignoring case", () => {
    expect(
      nameWithPreferred({ first_name: "Ada", last_name: "Lovelace", preferred_name: "ada" }),
    ).toBe("Ada Lovelace");
  });

  it("still shows the preferred name when there is no first name", () => {
    expect(
      nameWithPreferred({ first_name: null, last_name: "Lovelace", preferred_name: "Addy" }),
    ).toBe('"Addy" Lovelace');
  });
});

describe("commentDisplayName", () => {
  it("prefers the person's own override", () => {
    expect(
      commentDisplayName({
        first_name: "Ada",
        last_name: "Lovelace",
        display_name: "The Countess",
      }),
    ).toBe("The Countess");
  });

  it("derives preferred name + last initial when no override is set", () => {
    expect(
      commentDisplayName({
        first_name: "Ada",
        preferred_name: "Addy",
        last_name: "Lovelace",
        display_name: null,
      }),
    ).toBe("Addy L.");
  });

  it("derives first name + last initial when there is no preferred name", () => {
    expect(commentDisplayName({ first_name: "Ada", last_name: "Lovelace" })).toBe("Ada L.");
  });

  it("drops the last initial when there is no last name", () => {
    expect(commentDisplayName({ first_name: "Ada" })).toBe("Ada");
  });

  it("falls back to Member when there is no name at all", () => {
    expect(commentDisplayName({})).toBe("Member");
  });

  it("ignores a blank override", () => {
    expect(
      commentDisplayName({ first_name: "Ada", last_name: "Lovelace", display_name: "   " }),
    ).toBe("Ada L.");
  });
});

describe("blogPostSchema", () => {
  it("accepts a minimal draft with no slug (server derives one)", () => {
    const parsed = blogPostSchema.parse({ title: "Hello world", body_md: "Body text." });
    expect(parsed.status).toBe("draft");
    expect(parsed.slug).toBeUndefined();
  });

  it("rejects a slug with uppercase or spaces", () => {
    expect(() =>
      blogPostSchema.parse({ title: "Hello", body_md: "Body", slug: "Hello World" }),
    ).toThrow();
  });

  it("accepts a well-formed slug", () => {
    expect(
      blogPostSchema.parse({ title: "Hello", body_md: "Body", slug: "hello-world" }).slug,
    ).toBe("hello-world");
  });
});

describe("blogCommentSchema", () => {
  const postId = "11111111-1111-1111-1111-111111111111";

  it("accepts a plain top-level comment", () => {
    const parsed = blogCommentSchema.parse({ post_id: postId, body: "Great post!" });
    expect(parsed.parent_comment_id).toBeUndefined();
  });

  it("rejects an empty body", () => {
    expect(() => blogCommentSchema.parse({ post_id: postId, body: "" })).toThrow();
  });

  it("rejects a filled honeypot", () => {
    expect(() =>
      blogCommentSchema.parse({ post_id: postId, body: "Great post!", hp: "spam" }),
    ).toThrow();
  });
});

describe("blockCommenterSchema", () => {
  it("requires a valid user id to block someone", () => {
    expect(() => blockCommenterSchema.parse({ user_id: "not-a-uuid" })).toThrow();
  });
});

describe("updateMyProfileSchema", () => {
  // These two carried over from `updateDisplayNameSchema`, which this replaced.
  // They are the interesting half of the display-name contract: null and blank
  // are NOT the same thing, and the handler tells them apart.
  it("allows clearing a display name override with null", () => {
    expect(updateMyProfileSchema.parse({ display_name: null }).display_name).toBeNull();
  });

  it("rejects a blank (non-null) display name", () => {
    expect(() => updateMyProfileSchema.parse({ display_name: "" })).toThrow();
  });

  it("keeps an absent key distinct from an explicit null", () => {
    // "leave it alone" vs "clear it". The handler filters on `undefined`, so
    // collapsing these (with .nullish(), say) would make one impossible.
    const patch = updateMyProfileSchema.parse({ gi_size: null });
    expect(patch.gi_size).toBeNull();
    expect("display_name" in patch).toBe(false);
  });

  it("saves one card's fields at a time", () => {
    expect(updateMyProfileSchema.parse({ gi_size: "4", belt_size: "3" })).toEqual({
      gi_size: "4",
      belt_size: "3",
    });
  });

  it("rejects an empty patch", () => {
    expect(() => updateMyProfileSchema.parse({})).toThrow();
  });

  it("lets a member answer the media-consent question either way", () => {
    expect(updateMyProfileSchema.parse({ media_consent: true }).media_consent).toBe(true);
    expect(updateMyProfileSchema.parse({ media_consent: false }).media_consent).toBe(false);
  });

  // The column's null means "the club has never asked this person", which is a
  // statement about the club's records, not an answer a member can give. The
  // moment they look at the control that has stopped being true, so only a
  // manager can put a record back to unasked.
  it("refuses to let a member set media consent back to not-asked", () => {
    expect(() => updateMyProfileSchema.parse({ media_consent: null })).toThrow();
  });

  it("refuses fields this path does not own, rather than dropping them", () => {
    // A caller that thought it was saving a legal name should hear that it was
    // not. The schema is .strict() for exactly this.
    expect(() => updateMyProfileSchema.parse({ first_name: "Ada" })).toThrow();
    expect(() => updateMyProfileSchema.parse({ date_of_birth: "1990-01-01" })).toThrow();
    expect(() => updateMyProfileSchema.parse({ medical_notes: "None" })).toThrow();
    expect(() => updateMyProfileSchema.parse({ uts_student_number: "12345678" })).toThrow();
    expect(() => updateMyProfileSchema.parse({ is_minor: true })).toThrow();
    expect(() => updateMyProfileSchema.parse({ email: "ada@example.com" })).toThrow();
  });

  it("rejects a size that is not on the club's chart", () => {
    expect(() => updateMyProfileSchema.parse({ gi_size: "8" })).toThrow();
    // The belt chart is the shorter of the two: there is no 000 belt.
    expect(() => updateMyProfileSchema.parse({ belt_size: "000" })).toThrow();
    expect(updateMyProfileSchema.parse({ gi_size: "000" }).gi_size).toBe("000");
  });

  it("bounds the contact fields the same way the waiver does", () => {
    expect(() => updateMyProfileSchema.parse({ phone: "x".repeat(31) })).toThrow();
    expect(() => updateMyProfileSchema.parse({ address: "x".repeat(301) })).toThrow();
    expect(() => updateMyProfileSchema.parse({ emergency_contact_name: "" })).toThrow();
    expect(() => updateMyProfileSchema.parse({ emergency_contact_relationship: "" })).toThrow();
  });
});

describe("managerKitSizesSchema", () => {
  it("takes a person and both sizes, either of which may be cleared", () => {
    expect(
      managerKitSizesSchema.parse({
        userId: "11111111-1111-4111-8111-111111111111",
        gi_size: "5",
        belt_size: null,
      }),
    ).toEqual({
      userId: "11111111-1111-4111-8111-111111111111",
      gi_size: "5",
      belt_size: null,
    });
  });

  it("requires a real user id", () => {
    expect(() =>
      managerKitSizesSchema.parse({ userId: "nope", gi_size: null, belt_size: null }),
    ).toThrow();
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases so case/whitespace variants map to one profile", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeEmail("already@lower.com")).toBe("already@lower.com");
  });
});

describe("waiverToProfileFields", () => {
  it("maps exactly the submission's person fields onto the profile patch", () => {
    const fields = {
      first_name: "Ada",
      middle_name: null,
      last_name: "Lovelace",
      preferred_name: "Addy",
      date_of_birth: "1990-01-01",
      address: "1 Example St",
      phone: "0400 000 000",
      uts_student_number: "12345678",
      sms_whatsapp_consent: true,
      emergency_contact_name: "Grace Hopper",
      emergency_contact_relationship: "Colleague",
      emergency_contact_phone: "0400 111 111",
      medical_notes: "None",
      is_minor: false,
      guardian_name: null,
      guardian_relationship: null,
    };
    // Feed it a row with extra waiver-only keys; they must not leak through.
    const patch = waiverToProfileFields({
      ...fields,
      media_consent: true,
      pdf_path: "x.pdf",
      signer_ip: "203.0.113.7",
      email: "ada@example.com",
    } as never);
    expect(patch).toEqual({ ...fields, media_consent: true });
  });

  it("carries a declined media consent through as false", () => {
    const patch = waiverToProfileFields({ media_consent: false } as never);
    expect(patch.media_consent).toBe(false);
  });

  // Approving a waiver signed before the media question existed must not erase
  // a consent the club already holds. Setting the key to null would do exactly
  // that, so the patch has to leave it out altogether.
  it("omits media_consent entirely when the submission never asked", () => {
    const patch = waiverToProfileFields({ media_consent: null } as never);
    expect("media_consent" in patch).toBe(false);
  });

  it("does not carry kit sizes, which no waiver records", () => {
    // Sizing lives only on the profile, so approving a waiver must leave it
    // alone. If these ever appeared here, approving an old waiver would undo a
    // size a member or manager had since corrected.
    const patch = waiverToProfileFields({ gi_size: "4", belt_size: "3" } as never);
    expect("gi_size" in patch).toBe(false);
    expect("belt_size" in patch).toBe(false);
  });
});

describe("buildSignerMeta", () => {
  const headers: Record<string, string> = {
    "user-agent": "Mozilla/5.0 (test)",
    "accept-language": "en-AU,en;q=0.9",
    "sec-ch-ua-platform": '"macOS"',
  };
  const getHeader = (name: string) => headers[name];

  it("merges request headers with the browser's self-reported context", () => {
    const meta = buildSignerMeta(getHeader, {
      timezone: "Australia/Sydney",
      screen: "2560x1440",
      viewport: "1200x800",
      platform: "MacIntel",
      languages: ["en-AU", "en"],
    });
    expect(meta).toEqual({
      user_agent: "Mozilla/5.0 (test)",
      accept_language: "en-AU,en;q=0.9",
      sec_ch_ua_platform: '"macOS"',
      timezone: "Australia/Sydney",
      screen: "2560x1440",
      viewport: "1200x800",
      platform: "MacIntel",
      languages: ["en-AU", "en"],
    });
  });

  it("drops empty values so the blob stays compact", () => {
    const meta = buildSignerMeta(() => undefined, { timezone: "", languages: [] });
    expect(meta).toEqual({});
  });

  it("caps header values at 400 characters", () => {
    const meta = buildSignerMeta((n) => (n === "user-agent" ? "x".repeat(1000) : undefined), {});
    expect((meta.user_agent as string).length).toBe(400);
  });
});

describe("deriveWaiverListStatuses", () => {
  const row = (over: {
    id: string;
    user_id?: string;
    approval_status?: string;
    approved_at?: string | null;
    signed_at?: string;
  }) => ({
    user_id: "p1",
    approval_status: "pending",
    approved_at: null,
    signed_at: "2026-01-01T00:00:00Z",
    ...over,
  });

  it("marks unapproved waivers pending", () => {
    const statuses = deriveWaiverListStatuses([row({ id: "w1" })]);
    expect(statuses.get("w1")).toBe("pending");
  });

  it("marks the latest approved waiver active and older approved ones superseded", () => {
    const statuses = deriveWaiverListStatuses([
      row({ id: "old", approval_status: "approved", approved_at: "2026-01-02T00:00:00Z" }),
      row({ id: "new", approval_status: "approved", approved_at: "2026-03-02T00:00:00Z" }),
      row({ id: "pending" }),
    ]);
    expect(statuses.get("new")).toBe("active");
    expect(statuses.get("old")).toBe("superseded");
    expect(statuses.get("pending")).toBe("pending");
  });

  it("tracks active per person, not globally", () => {
    const statuses = deriveWaiverListStatuses([
      row({
        id: "a1",
        user_id: "pa",
        approval_status: "approved",
        approved_at: "2026-01-01T00:00:00Z",
      }),
      row({
        id: "b1",
        user_id: "pb",
        approval_status: "approved",
        approved_at: "2026-02-01T00:00:00Z",
      }),
    ]);
    expect(statuses.get("a1")).toBe("active");
    expect(statuses.get("b1")).toBe("active");
  });

  it("falls back to signed_at when approved_at is missing", () => {
    const statuses = deriveWaiverListStatuses([
      row({
        id: "w1",
        approval_status: "approved",
        approved_at: null,
        signed_at: "2026-01-01T00:00:00Z",
      }),
      row({
        id: "w2",
        approval_status: "approved",
        approved_at: null,
        signed_at: "2026-02-01T00:00:00Z",
      }),
    ]);
    expect(statuses.get("w2")).toBe("active");
    expect(statuses.get("w1")).toBe("superseded");
  });
});

describe("deriveExpandedWaivers", () => {
  const w = (id: string, signed_at: string, status: "pending" | "active" | "superseded") => ({
    id,
    signed_at,
    status,
  });

  it("expands the newest submission while it is still pending", () => {
    const open = deriveExpandedWaivers([
      w("older", "2026-01-01T00:00:00Z", "pending"),
      w("newest", "2026-03-01T00:00:00Z", "pending"),
    ]);
    expect([...open]).toEqual(["newest"]);
  });

  it("does not depend on the order rows arrive in", () => {
    const open = deriveExpandedWaivers([
      w("newest", "2026-03-01T00:00:00Z", "pending"),
      w("older", "2026-01-01T00:00:00Z", "pending"),
    ]);
    expect([...open]).toEqual(["newest"]);
  });

  it("expands nothing when the newest waiver is approved", () => {
    expect(deriveExpandedWaivers([w("w1", "2026-03-01T00:00:00Z", "active")]).size).toBe(0);
    expect(deriveExpandedWaivers([w("w1", "2026-03-01T00:00:00Z", "superseded")]).size).toBe(0);
  });

  it("leaves an older pending waiver collapsed when a newer one is approved", () => {
    const open = deriveExpandedWaivers([
      w("older", "2026-01-01T00:00:00Z", "pending"),
      w("newest", "2026-03-01T00:00:00Z", "active"),
    ]);
    expect(open.size).toBe(0);
  });

  it("expands nothing when there are no waivers", () => {
    expect(deriveExpandedWaivers([]).size).toBe(0);
  });

  it("keeps the first row on an exact signed_at tie", () => {
    // Rows arrive newest first, so first-seen wins is the sane tie-break.
    const open = deriveExpandedWaivers([
      w("first", "2026-03-01T00:00:00Z", "pending"),
      w("second", "2026-03-01T00:00:00Z", "pending"),
    ]);
    expect([...open]).toEqual(["first"]);
  });
});

describe("composeFullName", () => {
  it("joins first/middle/last with single spaces", () => {
    expect(composeFullName("Ada", "M", "Lovelace")).toBe("Ada M Lovelace");
  });

  it("drops blank/whitespace-only parts", () => {
    expect(composeFullName("Ada", "", "Lovelace")).toBe("Ada Lovelace");
    expect(composeFullName("Ada", "   ", "Lovelace")).toBe("Ada Lovelace");
  });

  it("trims each part", () => {
    expect(composeFullName("  Ada ", " M ", " Lovelace ")).toBe("Ada M Lovelace");
  });

  it("returns empty string when everything is blank", () => {
    expect(composeFullName("", " ", "")).toBe("");
  });
});

describe("splitFullName", () => {
  it("returns first only for a single word", () => {
    expect(splitFullName("Ada")).toEqual({ first: "Ada", middle: "", last: "" });
  });

  it("splits two words into first + last", () => {
    expect(splitFullName("Ada Lovelace")).toEqual({ first: "Ada", middle: "", last: "Lovelace" });
  });

  it("folds the middle words into the middle name for three+ words", () => {
    expect(splitFullName("Ada King Byron Lovelace")).toEqual({
      first: "Ada",
      middle: "King Byron",
      last: "Lovelace",
    });
  });

  it("collapses extra whitespace and ignores leading/trailing spaces", () => {
    expect(splitFullName("  Ada   M   Lovelace  ")).toEqual({
      first: "Ada",
      middle: "M",
      last: "Lovelace",
    });
  });

  it("returns all-empty parts for a blank string", () => {
    expect(splitFullName("   ")).toEqual({ first: "", middle: "", last: "" });
  });

  it("round-trips through composeFullName for a simple name", () => {
    const { first, middle, last } = splitFullName("Ada Lovelace");
    expect(composeFullName(first, middle, last)).toBe("Ada Lovelace");
  });
});

describe("resolveNamePrefill", () => {
  it("uses explicit first/last when provided (register free-trial flow)", () => {
    expect(resolveNamePrefill({ first_name: "Ada", last_name: "Lovelace" })).toEqual({
      first: "Ada",
      middle: "",
      last: "Lovelace",
    });
  });

  it("never guesses a middle name from structured params", () => {
    // "Mary Anne" as a given name stays intact instead of being mis-split.
    expect(resolveNamePrefill({ first_name: "Mary Anne", last_name: "Smith" })).toEqual({
      first: "Mary Anne",
      middle: "",
      last: "Smith",
    });
  });

  it("accepts a first name with no last name", () => {
    expect(resolveNamePrefill({ first_name: "Ada" })).toEqual({
      first: "Ada",
      middle: "",
      last: "",
    });
  });

  it("trims surrounding whitespace on structured params", () => {
    expect(resolveNamePrefill({ first_name: "  Ada  ", last_name: "  Lovelace  " })).toEqual({
      first: "Ada",
      middle: "",
      last: "Lovelace",
    });
  });

  it("falls back to splitting a single name for legacy links", () => {
    expect(resolveNamePrefill({ name: "Ada King Lovelace" })).toEqual({
      first: "Ada",
      middle: "King",
      last: "Lovelace",
    });
  });

  it("ignores blank structured params and falls back to the legacy name", () => {
    expect(resolveNamePrefill({ first_name: "  ", last_name: "", name: "Ada Lovelace" })).toEqual({
      first: "Ada",
      middle: "",
      last: "Lovelace",
    });
  });

  it("returns all-empty parts when nothing is provided", () => {
    expect(resolveNamePrefill({})).toEqual({ first: "", middle: "", last: "" });
  });
});

describe("decodeDataUrlPng", () => {
  it("decodes a valid base64 PNG data URL to bytes", () => {
    // "PNG" -> base64 "UE5H"
    const bytes = decodeDataUrlPng("data:image/png;base64,UE5H");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes!)).toEqual([0x50, 0x4e, 0x47]);
  });

  it("returns null for an empty string", () => {
    expect(decodeDataUrlPng("")).toBeNull();
  });

  it("returns null for a non-PNG or non-data-URL string", () => {
    expect(decodeDataUrlPng("data:image/jpeg;base64,UE5H")).toBeNull();
    expect(decodeDataUrlPng("just a name")).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(decodeDataUrlPng("data:image/png;base64,@@@not-base64@@@")).toBeNull();
  });
});

describe("interestSchema", () => {
  const valid = {
    name: "Sam Trainee",
    email: "sam@example.com",
  };

  it("accepts a minimal valid submission", () => {
    expect(interestSchema.safeParse(valid).success).toBe(true);
  });

  it("no longer requires a uts_student field (moved to the waiver)", () => {
    // Before this change the schema demanded `uts_student: z.boolean()`, so a
    // submission without it failed. Student status now lives on the waiver.
    const result = interestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.success && "uts_student" in result.data).toBe(false);
  });

  it("rejects an invalid email", () => {
    expect(interestSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(interestSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("accepts a composed first + last name at the 121-char cap", () => {
    // 60-char first + " " + 60-char last, the longest the register form can
    // compose (each field is capped at 60 to match the waiver).
    const name = `${"a".repeat(60)} ${"b".repeat(60)}`;
    expect(name.length).toBe(121);
    expect(interestSchema.safeParse({ ...valid, name }).success).toBe(true);
  });

  it("rejects a name over 121 chars", () => {
    expect(interestSchema.safeParse({ ...valid, name: "a".repeat(122) }).success).toBe(false);
  });

  it("rejects a filled honeypot", () => {
    expect(interestSchema.safeParse({ ...valid, hp: "bot" }).success).toBe(false);
  });

  it("allows an empty honeypot", () => {
    expect(interestSchema.safeParse({ ...valid, hp: "" }).success).toBe(true);
  });

  it("accepts a client_submission_id, and works without one", () => {
    // The idempotency key is optional so a client cached from before it shipped
    // still submits. Present, absent and "not set" (empty string) all pass.
    expect(
      interestSchema.safeParse({
        ...valid,
        client_submission_id: "3f7c1a2e-9b4d-4c8a-8e21-5d6f0a1b2c3d",
      }).success,
    ).toBe(true);
    expect(interestSchema.safeParse({ ...valid, client_submission_id: "" }).success).toBe(true);
    expect(interestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a client_submission_id that is not a uuid", () => {
    // Anything else would land in the uuid column as a cast error at insert
    // time, which is a 500 rather than a validation message.
    expect(interestSchema.safeParse({ ...valid, client_submission_id: "abc123" }).success).toBe(
      false,
    );
  });
});

describe("contactSchema", () => {
  const valid = {
    name: "Sam",
    email: "sam@example.com",
    message: "Hello, when do beginner classes run?",
  };

  it("accepts a valid message", () => {
    expect(contactSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a non-empty message", () => {
    expect(contactSchema.safeParse({ ...valid, message: "" }).success).toBe(false);
  });

  it("rejects a message over 2000 chars", () => {
    expect(contactSchema.safeParse({ ...valid, message: "x".repeat(2001) }).success).toBe(false);
  });

  it("accepts an optional client_submission_id and rejects a malformed one", () => {
    expect(
      contactSchema.safeParse({
        ...valid,
        client_submission_id: "3f7c1a2e-9b4d-4c8a-8e21-5d6f0a1b2c3d",
      }).success,
    ).toBe(true);
    expect(contactSchema.safeParse({ ...valid, client_submission_id: "" }).success).toBe(true);
    expect(contactSchema.safeParse({ ...valid, client_submission_id: "nope" }).success).toBe(false);
  });
});

describe("waiverSubmitSchema", () => {
  /** Every health question answered no: the "nothing to declare" baseline. */
  const noConcerns = {
    drugs: false,
    blackouts: false,
    device: false,
    impairments: false,
    other: false,
  };

  const validAdult = {
    first_name: "Ada",
    last_name: "Lovelace",
    date_of_birth: "1990-12-10",
    address: "1 Broadway, Ultimo NSW",
    phone: "0400000000",
    email: "ada@example.com",
    emergency_contact_name: "Charles Babbage",
    emergency_contact_relationship: "Colleague",
    emergency_contact_phone: "0400000001",
    health_answers: noConcerns,
    signature_name: "Ada Lovelace",
  };

  it("accepts a valid adult waiver with a typed signature", () => {
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
  });

  it("accepts an optional verification token, and works fine without one", () => {
    // A walk-in signer has no token; someone who came from their interest email
    // does. Both are ordinary submissions, so neither may be rejected here.
    expect(waiverSubmitSchema.safeParse({ ...validAdult, vt: "utsj_abc123" }).success).toBe(true);
    expect(waiverSubmitSchema.safeParse({ ...validAdult, vt: "" }).success).toBe(true);
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
  });

  it("accepts optional previous martial arts experience, and rejects an oversized one", () => {
    // Moved onto the waiver from the "Start your free trial" form: optional
    // either way, so a walk-in signer who skips it is still a valid waiver.
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, martial_arts_experience: "2 years BJJ" })
        .success,
    ).toBe(true);
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, martial_arts_experience: "" }).success,
    ).toBe(true);
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, martial_arts_experience: "x".repeat(501) })
        .success,
    ).toBe(false);
  });

  it("accepts an optional client_submission_id and rejects a malformed one", () => {
    // The key that makes retrying a waiver safe. It must never be required (an
    // older cached client sends none), and it must never be accepted in a shape
    // the uuid column would reject at insert time.
    expect(
      waiverSubmitSchema.safeParse({
        ...validAdult,
        client_submission_id: "3f7c1a2e-9b4d-4c8a-8e21-5d6f0a1b2c3d",
      }).success,
    ).toBe(true);
    expect(waiverSubmitSchema.safeParse({ ...validAdult, client_submission_id: "" }).success).toBe(
      true,
    );
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, client_submission_id: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("accepts optional client_meta and rejects oversized values", () => {
    const withMeta = waiverSubmitSchema.safeParse({
      ...validAdult,
      client_meta: {
        timezone: "Australia/Sydney",
        screen: "2560x1440",
        languages: ["en-AU", "en"],
      },
    });
    expect(withMeta.success).toBe(true);

    const oversized = waiverSubmitSchema.safeParse({
      ...validAdult,
      client_meta: { timezone: "x".repeat(200) },
    });
    expect(oversized.success).toBe(false);
  });

  it("carries the template version the signer read, and only a real one", () => {
    // The server compares this against the live template and refuses a mismatch,
    // so a submission cannot be filed against text that was promoted while the
    // form was open. Optional, so a client that predates it still submits.
    expect(waiverSubmitSchema.safeParse({ ...validAdult, template_version: 2 }).success).toBe(true);
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
    expect(waiverSubmitSchema.safeParse({ ...validAdult, template_version: 0 }).success).toBe(
      false,
    );
    expect(waiverSubmitSchema.safeParse({ ...validAdult, template_version: 1.5 }).success).toBe(
      false,
    );
  });

  it("accepts a drawn signature (image) with no typed name", () => {
    const result = waiverSubmitSchema.safeParse({
      ...validAdult,
      signature_name: "",
      signature_image: "data:image/png;base64,UE5H",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when neither typed nor drawn signature is provided", () => {
    const result = waiverSubmitSchema.safeParse({
      ...validAdult,
      signature_name: "",
      signature_image: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("signature_name"))).toBe(true);
    }
  });

  it("accepts an acknowledgements map and defaults it to {}", () => {
    const withMap = waiverSubmitSchema.safeParse({
      ...validAdult,
      acknowledgements: { risk: true, media: false },
    });
    expect(withMap.success && withMap.data.acknowledgements).toEqual({ risk: true, media: false });
    const without = waiverSubmitSchema.safeParse(validAdult);
    expect(without.success && without.data.acknowledgements).toEqual({});
  });

  it("rejects a malformed date of birth", () => {
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, date_of_birth: "10/12/1990" }).success,
    ).toBe(false);
  });

  it("accepts an optional UTS student number", () => {
    const result = waiverSubmitSchema.safeParse({ ...validAdult, uts_student_number: "12345678" });
    expect(result.success && result.data.uts_student_number).toBe("12345678");
  });

  it("allows the UTS student number to be omitted", () => {
    const result = waiverSubmitSchema.safeParse(validAdult);
    expect(result.success).toBe(true);
  });

  it("rejects a UTS student number over 20 chars", () => {
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, uts_student_number: "1".repeat(21) }).success,
    ).toBe(false);
  });

  it("accepts an optional preferred name and trims it", () => {
    const result = waiverSubmitSchema.safeParse({ ...validAdult, preferred_name: "  Addy  " });
    expect(result.success && result.data.preferred_name).toBe("Addy");
  });

  it("allows the preferred name to be omitted or blank", () => {
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
    expect(waiverSubmitSchema.safeParse({ ...validAdult, preferred_name: "" }).success).toBe(true);
  });

  it("rejects a preferred name over 60 chars", () => {
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, preferred_name: "a".repeat(61) }).success,
    ).toBe(false);
  });

  it("defaults sms_whatsapp_consent to false when omitted", () => {
    const result = waiverSubmitSchema.safeParse(validAdult);
    expect(result.success && result.data.sms_whatsapp_consent).toBe(false);
  });

  it("accepts sms_whatsapp_consent when opted in", () => {
    const result = waiverSubmitSchema.safeParse({ ...validAdult, sms_whatsapp_consent: true });
    expect(result.success && result.data.sms_whatsapp_consent).toBe(true);
  });

  // Media consent is deliberately NOT a field on this schema: it is derived
  // server-side from the acknowledgement the signer ticked on the document, so
  // the column and the PDF can never disagree, and a crafted request cannot
  // claim a consent the signed page does not show.
  it("ignores a client-supplied media_consent", () => {
    const result = waiverSubmitSchema.safeParse({ ...validAdult, media_consent: true });
    expect(result.success).toBe(true);
    expect(result.success && "media_consent" in result.data).toBe(false);
  });

  it("defaults is_minor to false when omitted", () => {
    const result = waiverSubmitSchema.safeParse(validAdult);
    expect(result.success && result.data.is_minor).toBe(false);
  });

  it("requires a guardian signature for a minor", () => {
    const result = waiverSubmitSchema.safeParse({ ...validAdult, is_minor: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("guardian_signature"))).toBe(true);
    }
  });

  // The guardian's name and relationship are the emergency contact fields (the
  // form asks for that person once, and the server copies them across), so a
  // minor's payload carries no separate guardian identity.
  it("accepts a minor with only the emergency contact and a guardian signature", () => {
    const result = waiverSubmitSchema.safeParse({
      ...validAdult,
      is_minor: true,
      guardian_signature: "Charles Babbage",
    });
    expect(result.success).toBe(true);
  });

  it("requires the emergency contact's relationship", () => {
    const { emergency_contact_relationship: _omitted, ...withoutRelationship } = validAdult;
    expect(waiverSubmitSchema.safeParse(withoutRelationship).success).toBe(false);
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, emergency_contact_relationship: "  " }).success,
    ).toBe(false);
  });

  it("requires every health question to be answered", () => {
    const { drugs: _unanswered, ...missingOne } = noConcerns;
    const result = waiverSubmitSchema.safeParse({ ...validAdult, health_answers: missingOne });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("drugs"))).toBe(true);
    }
  });

  // A "yes" nobody explained tells an instructor nothing, so the details box
  // the form has always had stops being optional.
  it("requires medical details once any health question is answered yes", () => {
    const concern = { ...noConcerns, impairments: true };
    const withoutDetails = waiverSubmitSchema.safeParse({
      ...validAdult,
      health_answers: concern,
    });
    expect(withoutDetails.success).toBe(false);
    if (!withoutDetails.success) {
      expect(withoutDetails.error.issues.some((i) => i.path.includes("medical_notes"))).toBe(true);
    }

    const withDetails = waiverSubmitSchema.safeParse({
      ...validAdult,
      health_answers: concern,
      medical_notes: "Weak left ankle, taped for training.",
    });
    expect(withDetails.success).toBe(true);
  });

  it("leaves medical details optional when nothing is declared", () => {
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
    expect(waiverSubmitSchema.safeParse({ ...validAdult, medical_notes: "" }).success).toBe(true);
  });

  it("rejects a filled honeypot", () => {
    expect(waiverSubmitSchema.safeParse({ ...validAdult, hp: "bot" }).success).toBe(false);
  });
});

describe("saveTemplateSchema", () => {
  it("accepts a valid template", () => {
    expect(saveTemplateSchema.safeParse({ title: "Waiver v2", body_md: "# Hi" }).success).toBe(
      true,
    );
  });

  it("requires a non-empty title and body", () => {
    expect(saveTemplateSchema.safeParse({ title: "", body_md: "# Hi" }).success).toBe(false);
    expect(saveTemplateSchema.safeParse({ title: "T", body_md: "" }).success).toBe(false);
  });

  it("accepts acknowledgements and defaults them to []", () => {
    const withAcks = saveTemplateSchema.safeParse({
      title: "T",
      body_md: "# Hi",
      acknowledgements: [{ id: "risk", label: "I accept the risks.", required: true }],
    });
    expect(withAcks.success && withAcks.data.acknowledgements).toHaveLength(1);
    const without = saveTemplateSchema.safeParse({ title: "T", body_md: "# Hi" });
    expect(without.success && without.data.acknowledgements).toEqual([]);
  });

  it("rejects an acknowledgement with an empty label", () => {
    expect(
      saveTemplateSchema.safeParse({
        title: "T",
        body_md: "# Hi",
        acknowledgements: [{ id: "x", label: "", required: true }],
      }).success,
    ).toBe(false);
  });
});

describe("setCurrentTemplateSchema", () => {
  it("accepts a template id", () => {
    expect(
      setCurrentTemplateSchema.safeParse({ id: "11111111-1111-1111-1111-111111111111" }).success,
    ).toBe(true);
  });

  it("rejects anything that is not a uuid", () => {
    // The handler clears `is_current` on every row before setting it on the
    // target, so a version number or a title reaching it would demote the live
    // waiver and promote nothing.
    expect(setCurrentTemplateSchema.safeParse({ id: "2" }).success).toBe(false);
    expect(setCurrentTemplateSchema.safeParse({}).success).toBe(false);
  });
});

describe("waiverApprovalSchema", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  it("accepts a valid uuid + approved status", () => {
    const r = waiverApprovalSchema.safeParse({ id, status: "approved" });
    expect(r.success && r.data).toEqual({ id, status: "approved" });
  });

  it("accepts a valid uuid + pending status", () => {
    expect(waiverApprovalSchema.safeParse({ id, status: "pending" }).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(waiverApprovalSchema.safeParse({ id, status: "rejected" }).success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    expect(waiverApprovalSchema.safeParse({ id: "not-a-uuid", status: "approved" }).success).toBe(
      false,
    );
  });

  it("requires both fields", () => {
    expect(waiverApprovalSchema.safeParse({ id }).success).toBe(false);
    expect(waiverApprovalSchema.safeParse({ status: "approved" }).success).toBe(false);
  });
});

describe("managerEmailChangeSchema", () => {
  const userId = "11111111-1111-1111-1111-111111111111";

  it("accepts a user id and a new address", () => {
    const r = managerEmailChangeSchema.safeParse({ userId, email: "  Ada@Example.com " });
    // Trimmed here; lowercasing is `normalizeEmail`'s job at the call site, so
    // the schema keeps the address as typed apart from surrounding space.
    expect(r.success && r.data.email).toBe("Ada@Example.com");
  });

  it("rejects a malformed address", () => {
    expect(managerEmailChangeSchema.safeParse({ userId, email: "not-an-email" }).success).toBe(
      false,
    );
  });

  it("rejects a non-uuid user id", () => {
    expect(
      managerEmailChangeSchema.safeParse({ userId: "nope", email: "ada@example.com" }).success,
    ).toBe(false);
  });

  it("has no way to assert verification", () => {
    // The product rule, pinned as a shape: there is no "mark as verified" input.
    // A badge a manager could set would only mean "a manager believed this",
    // which is the state this whole feature exists to replace. Correcting an
    // address sends a fresh link; that is the entire remedy.
    const r = managerEmailChangeSchema.safeParse({
      userId,
      email: "ada@example.com",
      email_confirmed_at: "2026-01-01T00:00:00Z",
      verified: true,
    });
    expect(r.success && Object.keys(r.data).sort()).toEqual(["email", "userId"]);
  });
});

describe("codeOfConductAcceptSchema", () => {
  const valid = { agree: true as const, signature_name: "Ada Lovelace", version: 1 };

  it("accepts an agreement signed with a typed name", () => {
    const r = codeOfConductAcceptSchema.safeParse({ ...valid, token: " tok " });
    expect(r.success && r.data.signature_name).toBe("Ada Lovelace");
    expect(r.success && r.data.token).toBe("tok");
  });

  it("works without a token, for a signed-in member", () => {
    expect(codeOfConductAcceptSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses an unticked box", () => {
    // `agree` is a literal, not a boolean, so an unticked box cannot reach the
    // handler at all. An agreement from somebody who did not agree is not
    // evidence of anything.
    expect(codeOfConductAcceptSchema.safeParse({ ...valid, agree: false }).success).toBe(false);
    expect(codeOfConductAcceptSchema.safeParse({ signature_name: "Ada", version: 1 }).success).toBe(
      false,
    );
  });

  it("requires a signature", () => {
    expect(codeOfConductAcceptSchema.safeParse({ ...valid, signature_name: "   " }).success).toBe(
      false,
    );
  });

  it("requires the version that was read", () => {
    expect(
      codeOfConductAcceptSchema.safeParse({ agree: true, signature_name: "Ada" }).success,
    ).toBe(false);
    expect(codeOfConductAcceptSchema.safeParse({ ...valid, version: 0 }).success).toBe(false);
  });

  it("takes no name or email: the server reads those off the person's record", () => {
    // The rule that stops anyone agreeing on somebody else's behalf by typing
    // their address. If these ever become inputs, that protection is gone.
    const r = codeOfConductAcceptSchema.safeParse({
      ...valid,
      full_name: "Someone Else",
      email: "someone@example.com",
      user_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(r.success && Object.keys(r.data).sort()).toEqual(["agree", "signature_name", "version"]);
  });

  it("drops a submission with the honeypot filled", () => {
    expect(codeOfConductAcceptSchema.safeParse({ ...valid, hp: "bot" }).success).toBe(false);
  });
});

describe("waiverPrefillSearchSchema", () => {
  it("keeps string prefill values as-is", () => {
    const r = waiverPrefillSearchSchema.safeParse({
      name: "Fntest9 lntest9",
      email: "sensei+test9@sydneyjitsu.com.au",
      phone: "+61 400 000 000",
    });
    expect(r.success && r.data).toEqual({
      name: "Fntest9 lntest9",
      email: "sensei+test9@sydneyjitsu.com.au",
      phone: "+61 400 000 000",
    });
  });

  it("keeps the verification token from an emailed link", () => {
    const r = waiverPrefillSearchSchema.safeParse({ email: "ada@example.com", vt: "utsj_abc123" });
    expect(r.success && r.data.vt).toBe("utsj_abc123");
  });

  it("coerces an all-digits phone (parsed as a number by the router) to a string", () => {
    // TanStack Router runs search params through JSON.parse, so ?phone=61313131
    // arrives here as the number 61313131. It must still prefill.
    const r = waiverPrefillSearchSchema.safeParse({ phone: 61313131 });
    expect(r.success && r.data.phone).toBe("61313131");
  });

  it("coerces numeric name / email values to strings too", () => {
    const r = waiverPrefillSearchSchema.safeParse({ name: 12345, email: 678 });
    expect(r.success && r.data.name).toBe("12345");
    expect(r.success && r.data.email).toBe("678");
  });

  it("leaves omitted fields undefined", () => {
    const r = waiverPrefillSearchSchema.safeParse({});
    expect(r.success && r.data).toEqual({});
  });

  it("drops an over-long value to undefined rather than failing the route", () => {
    const r = waiverPrefillSearchSchema.safeParse({ phone: "0".repeat(31) });
    expect(r.success).toBe(true);
    expect(r.success && r.data.phone).toBeUndefined();
  });
});

describe("isUtsStudent", () => {
  // The single rule both the membership page (price preview) and the server
  // (authoritative pricing) rely on. A non-empty UTS number means student.
  it("is a student when a non-empty number is present", () => {
    expect(isUtsStudent("12345678")).toBe(true);
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(isUtsStudent("  12345678  ")).toBe(true);
    expect(isUtsStudent("   ")).toBe(false);
  });

  it("is not a student for empty, null, or undefined", () => {
    expect(isUtsStudent("")).toBe(false);
    expect(isUtsStudent(null)).toBe(false);
    expect(isUtsStudent(undefined)).toBe(false);
  });
});

describe("createCalendarEntrySchema", () => {
  const details = { title: "Beginner Gi" };
  const once = {
    type: "never" as const,
    starts_at: "2026-08-01T09:00:00.000Z",
    ends_at: "2026-08-01T10:30:00.000Z",
  };
  const weekly = {
    type: "weekly" as const,
    weekday: 1,
    start_time: "18:00",
    duration_minutes: 90,
    starts_on: "2026-07-06",
  };

  it("needs nothing but a title and when it happens", () => {
    const result = createCalendarEntrySchema.safeParse({ ...details, repeat: once });
    expect(result.success).toBe(true);
    if (result.success) {
      // Everything else is optional, and blank stays blank rather than "".
      expect(result.data.instructor_name).toBeUndefined();
      expect(result.data.location).toBeUndefined();
      expect(result.data.description).toBeUndefined();
      expect(result.data.visibility).toBe("public");
      expect(result.data.invite_only).toBe(false);
    }
  });

  it("rejects a missing or empty title", () => {
    expect(createCalendarEntrySchema.safeParse({ repeat: once }).success).toBe(false);
    expect(createCalendarEntrySchema.safeParse({ title: "   ", repeat: once }).success).toBe(false);
  });

  it("normalises blank optional text to undefined, so the column ends up NULL", () => {
    const result = createCalendarEntrySchema.safeParse({
      ...details,
      instructor_name: "   ",
      location: "",
      description: "  ",
      repeat: once,
    });
    expect(result.success && result.data.instructor_name).toBeUndefined();
    expect(result.success && result.data.location).toBeUndefined();
    expect(result.success && result.data.description).toBeUndefined();
  });

  // The whole point of the redesign: this combination was unexpressible before,
  // because visibility and invite_only lived only on one-off events.
  it("allows a WEEKLY entry to be members-only and invite-only", () => {
    const result = createCalendarEntrySchema.safeParse({
      ...details,
      visibility: "members",
      invite_only: true,
      repeat: weekly,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.visibility).toBe("members");
    expect(result.success && result.data.invite_only).toBe(true);
    expect(result.success && result.data.repeat.type).toBe("weekly");
  });

  it("treats a weekly entry with no end date as open-ended", () => {
    const result = createCalendarEntrySchema.safeParse({ ...details, repeat: weekly });
    expect(result.success).toBe(true);
    const parsed = result.success && result.data.repeat;
    expect(parsed && parsed.type === "weekly" && parsed.ends_on).toBeUndefined();
    expect(
      createCalendarEntrySchema.safeParse({
        ...details,
        repeat: { ...weekly, ends_on: null },
      }).success,
    ).toBe(true);
  });

  it("rejects a one-off that ends before it starts", () => {
    const result = createCalendarEntrySchema.safeParse({
      ...details,
      repeat: { ...once, ends_at: "2026-08-01T08:00:00.000Z" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("ends_at"))).toBe(true);
    }
  });

  it("rejects a weekly entry ending before its first date", () => {
    const result = createCalendarEntrySchema.safeParse({
      ...details,
      repeat: { ...weekly, ends_on: "2026-07-05" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("ends_on"))).toBe(true);
    }
  });

  it("will not accept weekly fields on a one-off, or the reverse", () => {
    // The discriminated union is what makes these mistakes unrepresentable.
    expect(
      createCalendarEntrySchema.safeParse({
        ...details,
        repeat: { type: "never", weekday: 1, start_time: "18:00" },
      }).success,
    ).toBe(false);
    expect(
      createCalendarEntrySchema.safeParse({
        ...details,
        repeat: { type: "weekly", starts_at: once.starts_at, ends_at: once.ends_at },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown repeat type and an unknown visibility", () => {
    expect(
      createCalendarEntrySchema.safeParse({ ...details, repeat: { type: "monthly" } }).success,
    ).toBe(false);
    expect(
      createCalendarEntrySchema.safeParse({ ...details, visibility: "secret", repeat: once })
        .success,
    ).toBe(false);
  });
});

describe("updateCalendarEntrySchema", () => {
  const id = crypto.randomUUID();

  // `id` is the clicked DATE in both scopes, so "all future" is measured from
  // there. The server resolves the series; the client never sends a series id.
  it("accepts both scopes, keyed by the clicked date", () => {
    expect(updateCalendarEntrySchema.safeParse({ scope: "event", id, title: "New" }).success).toBe(
      true,
    );
    expect(
      updateCalendarEntrySchema.safeParse({ scope: "series", id, visibility: "members" }).success,
    ).toBe(true);
  });

  it("allows clearing an optional field with null", () => {
    expect(
      updateCalendarEntrySchema.safeParse({ scope: "event", id, instructor_name: null }).success,
    ).toBe(true);
  });

  it("rejects an unknown scope, and schedule fields it must not change", () => {
    expect(updateCalendarEntrySchema.safeParse({ scope: "all", id }).success).toBe(false);
    // Changing the day or time would invalidate dates already on the calendar,
    // so it is deliberately not editable here.
    expect(updateCalendarEntrySchema.safeParse({ scope: "series", id, weekday: 2 }).success).toBe(
      false,
    );
  });
});

describe("rsvpSchema", () => {
  it("accepts the three valid responses", () => {
    for (const response of ["going", "maybe", "declined"]) {
      expect(rsvpSchema.safeParse({ event_id: crypto.randomUUID(), response }).success).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(rsvpSchema.safeParse({ event_id: crypto.randomUUID(), response: "yes" }).success).toBe(
      false,
    );
  });
});

describe("cancelEventSchema", () => {
  it("requires an explicit boolean so cancel and restore are both intentional", () => {
    const id = crypto.randomUUID();
    expect(cancelEventSchema.safeParse({ id, cancelled: true }).success).toBe(true);
    expect(cancelEventSchema.safeParse({ id, cancelled: false }).success).toBe(true);
    expect(cancelEventSchema.safeParse({ id }).success).toBe(false);
  });

  it("defaults to this date only, and accepts the all-future scope", () => {
    const id = crypto.randomUUID();
    const one = cancelEventSchema.safeParse({ id, cancelled: true });
    // The safe default: a caller that forgets the scope cancels one date, not
    // every remaining one.
    expect(one.success && one.data.scope).toBe("event");
    expect(cancelEventSchema.safeParse({ scope: "series", id, cancelled: true }).success).toBe(
      true,
    );
    expect(cancelEventSchema.safeParse({ scope: "all", id, cancelled: true }).success).toBe(false);
  });
});

describe("stopRepeatingSchema", () => {
  it("takes the series, not one of its dates", () => {
    expect(stopRepeatingSchema.safeParse({ series_id: crypto.randomUUID() }).success).toBe(true);
    expect(stopRepeatingSchema.safeParse({ series_id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("base64ByteLength", () => {
  it("counts the decoded bytes without decoding", () => {
    // "hi" -> "aGk=" (2 bytes, one pad), "hip" -> "aGlw" (3 bytes, no pad).
    expect(base64ByteLength("aGk=")).toBe(2);
    expect(base64ByteLength("aGlw")).toBe(3);
    expect(base64ByteLength("YQ==")).toBe(1);
    expect(base64ByteLength("")).toBe(0);
  });

  it("ignores whitespace, which a wrapped data URL carries", () => {
    expect(base64ByteLength("aGlw\n")).toBe(3);
    expect(base64ByteLength(" aG lw ")).toBe(3);
  });
});

describe("isMinorOn", () => {
  it("is true only for someone under 18 on the given date", () => {
    expect(isMinorOn("2010-06-01", "2026-07-29")).toBe(true);
    expect(isMinorOn("2000-06-01", "2026-07-29")).toBe(false);
  });

  it("turns 18 on the birthday itself, not the day after", () => {
    expect(isMinorOn("2008-07-29", "2026-07-29")).toBe(false);
    expect(isMinorOn("2008-07-30", "2026-07-29")).toBe(true);
  });

  it("compares date parts, so a Sydney manager gets the same answer as UTC", () => {
    // Parsed as Dates these are UTC midnights, and the naive difference would
    // shift by a day either side of the birthday for anyone west of Greenwich.
    expect(isMinorOn("2008-12-31", "2026-12-31")).toBe(false);
    expect(isMinorOn("2008-12-31", "2026-12-30")).toBe(true);
  });

  it("returns false for a malformed date rather than guessing", () => {
    expect(isMinorOn("", "2026-07-29")).toBe(false);
    expect(isMinorOn("2010-06-01", "not-a-date")).toBe(false);
  });
});

describe("isFutureSigningDate", () => {
  const now = "2026-07-29T12:00:00.000Z";

  it("accepts today and any past date", () => {
    expect(isFutureSigningDate("2026-07-29", now)).toBe(false);
    expect(isFutureSigningDate("2019-01-02", now)).toBe(false);
  });

  it("allows one day of slack, because the club is UTC+10 and the server is UTC", () => {
    // 10am Sydney on the 30th is still the 29th in UTC; a form dated that day
    // is correct and must not be refused.
    expect(isFutureSigningDate("2026-07-30", now)).toBe(false);
  });

  it("rejects a date beyond that slack", () => {
    expect(isFutureSigningDate("2026-07-31", now)).toBe(true);
    expect(isFutureSigningDate("2026-08-29", now)).toBe(true);
  });

  it("does not reject when the clock is unreadable", () => {
    expect(isFutureSigningDate("2026-07-31", "nonsense")).toBe(false);
  });
});

describe("isPaperWaiver", () => {
  it("is true only for a signing context marked as a paper upload", () => {
    expect(isPaperWaiver({ source: "paper_upload", uploaded_by: "u1" })).toBe(true);
    expect(isPaperWaiver({ user_agent: "Mozilla/5.0", timezone: "Australia/Sydney" })).toBe(false);
  });

  it("is false for anything that is not an object of fields", () => {
    expect(isPaperWaiver(null)).toBe(false);
    expect(isPaperWaiver(undefined)).toBe(false);
    expect(isPaperWaiver("paper_upload")).toBe(false);
    expect(isPaperWaiver([{ source: "paper_upload" }])).toBe(false);
  });
});

describe("nextUtcDay", () => {
  it("advances one UTC day", () => {
    expect(nextUtcDay("2026-07-20")).toBe("2026-07-21");
  });

  it("rolls over month and year ends, and handles a leap day", () => {
    expect(nextUtcDay("2026-07-31")).toBe("2026-08-01");
    expect(nextUtcDay("2026-12-31")).toBe("2027-01-01");
    expect(nextUtcDay("2028-02-28")).toBe("2028-02-29");
    expect(nextUtcDay("2027-02-28")).toBe("2027-03-01");
  });
});

describe("paperWaiverUploadSchema", () => {
  /** A one-page scan: base64 is not decoded by the schema, only sized. */
  const onePage = [{ name: "waiver.pdf", type: "application/pdf" as const, data: "aGlw" }];

  const validAdult = {
    first_name: "Ada",
    last_name: "Lovelace",
    date_of_birth: "1990-12-10",
    address: "1 Broadway, Ultimo NSW",
    phone: "0400000000",
    email: "ada@example.com",
    emergency_contact_name: "Charles Babbage",
    emergency_contact_phone: "0400000001",
    signed_on: "2026-07-20",
    scan: onePage,
  };

  it("accepts a filed adult form", () => {
    expect(paperWaiverUploadSchema.safeParse(validAdult).success).toBe(true);
  });

  // Without .strict() Zod STRIPS an unknown key, so a misspelled confirm flag
  // would vanish, default to false, and return the same 409 — telling the caller
  // to do the thing they believe they just did, with no signal it never arrived.
  // An agent guessing a name from prose is exactly who this endpoint serves.
  it("rejects a misspelled confirm flag instead of silently dropping it", () => {
    const result = paperWaiverUploadSchema.safeParse({
      ...validAdult,
      confirmDuplicate: true,
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0].message).toMatch(/confirmDuplicate/);
  });

  it("still takes the correctly spelled flag", () => {
    const parsed = paperWaiverUploadSchema.parse({ ...validAdult, confirm_duplicate: true });
    expect(parsed.confirm_duplicate).toBe(true);
    // And defaults it when absent, rather than leaving it undefined.
    expect(paperWaiverUploadSchema.parse(validAdult).confirm_duplicate).toBe(false);
  });

  it("does not ask for a signature, ticks or health answers: they are on the scan", () => {
    // The whole point of the scan being the signed article. If any of these
    // ever became required here, a manager would be retyping evidence.
    const parsed = paperWaiverUploadSchema.parse(validAdult);
    expect(parsed).not.toHaveProperty("signature_name");
    expect(parsed).not.toHaveProperty("acknowledgements");
    expect(parsed).not.toHaveProperty("health_answers");
  });

  it("requires a scan, and caps how many files one upload carries", () => {
    expect(paperWaiverUploadSchema.safeParse({ ...validAdult, scan: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 21 }, () => onePage[0]);
    expect(paperWaiverUploadSchema.safeParse({ ...validAdult, scan: tooMany }).success).toBe(false);
  });

  it("rejects a file type that is not a PDF or a photo", () => {
    const res = paperWaiverUploadSchema.safeParse({
      ...validAdult,
      scan: [{ name: "waiver.docx", type: "application/msword", data: "aGlw" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects a scan over the size limit, measured on the decoded bytes", () => {
    // Base64 inflates by a third, so a limit checked on the string length would
    // let a file a third over the cap straight through.
    const oversized = "A".repeat(Math.ceil((MAX_SCAN_BYTES + 1024) / 3) * 4);
    const res = paperWaiverUploadSchema.safeParse({
      ...validAdult,
      scan: [{ name: "scan.png", type: "image/png", data: oversized }],
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path).toEqual(["scan"]);
  });

  it("sums the files, so a stack of photos cannot slip past the cap one at a time", () => {
    const half = "A".repeat(Math.ceil((MAX_SCAN_BYTES * 0.6) / 3) * 4);
    const res = paperWaiverUploadSchema.safeParse({
      ...validAdult,
      scan: [
        { name: "p1.jpg", type: "image/jpeg", data: half },
        { name: "p2.jpg", type: "image/jpeg", data: half },
      ],
    });
    expect(res.success).toBe(false);
  });

  it("leaves the emergency contact relationship optional for an adult", () => {
    // Older paper forms did not ask for it. A manager must not have to invent
    // one to file a real article.
    expect(paperWaiverUploadSchema.safeParse(validAdult).success).toBe(true);
    expect(
      paperWaiverUploadSchema.safeParse({ ...validAdult, emergency_contact_relationship: "" })
        .success,
    ).toBe(true);
  });

  it("requires the relationship when the applicant was under 18 when they signed", () => {
    const minor = { ...validAdult, date_of_birth: "2012-01-05" };
    const res = paperWaiverUploadSchema.safeParse(minor);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path).toEqual(["emergency_contact_relationship"]);
    expect(
      paperWaiverUploadSchema.safeParse({ ...minor, emergency_contact_relationship: "Mother" })
        .success,
    ).toBe(true);
  });

  it("judges minority on the date signed, not on today", () => {
    // A form signed in 2019 by a 16 year old is a minor's form forever, even
    // though that person is an adult by the time it is filed.
    const res = paperWaiverUploadSchema.safeParse({
      ...validAdult,
      date_of_birth: "2003-05-01",
      signed_on: "2019-06-01",
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path).toEqual(["emergency_contact_relationship"]);
  });

  it("requires the person fields the waivers table cannot store as null", () => {
    for (const field of [
      "first_name",
      "last_name",
      "date_of_birth",
      "address",
      "phone",
      "email",
      "emergency_contact_name",
      "emergency_contact_phone",
      "signed_on",
    ]) {
      const without = { ...validAdult } as Record<string, unknown>;
      delete without[field];
      expect(paperWaiverUploadSchema.safeParse(without).success, field).toBe(false);
    }
  });

  it("insists on a real date for the signing date and the birth date", () => {
    expect(
      paperWaiverUploadSchema.safeParse({ ...validAdult, signed_on: "20/07/2026" }).success,
    ).toBe(false);
    expect(
      paperWaiverUploadSchema.safeParse({ ...validAdult, date_of_birth: "10 Dec 1990" }).success,
    ).toBe(false);
  });

  it("takes a template version or an honest null for a form nobody can place", () => {
    expect(paperWaiverUploadSchema.safeParse({ ...validAdult, template_version: 3 }).success).toBe(
      true,
    );
    expect(
      paperWaiverUploadSchema.safeParse({ ...validAdult, template_version: null }).success,
    ).toBe(true);
    expect(paperWaiverUploadSchema.safeParse({ ...validAdult, template_version: 0 }).success).toBe(
      false,
    );
  });

  it("defaults the SMS consent to no, so an unticked box is never consent", () => {
    expect(paperWaiverUploadSchema.parse(validAdult).sms_whatsapp_consent).toBe(false);
    // Not false: a paper form with no photo box never asked the question, and a
    // filing manager must not be made to record a refusal on someone's behalf.
    expect(paperWaiverUploadSchema.parse(validAdult).media_consent).toBeNull();
    expect(
      paperWaiverUploadSchema.parse({ ...validAdult, media_consent: true }).media_consent,
    ).toBe(true);
    expect(
      paperWaiverUploadSchema.parse({ ...validAdult, media_consent: false }).media_consent,
    ).toBe(false);
  });
});

describe("check-in schemas", () => {
  it("checkInSchema needs a real class and a real person", () => {
    const ok = { event_id: crypto.randomUUID(), user_id: crypto.randomUUID() };
    expect(checkInSchema.safeParse(ok).success).toBe(true);
    expect(checkInSchema.safeParse({ ...ok, event_id: "not-a-uuid" }).success).toBe(false);
    expect(checkInSchema.safeParse({ event_id: ok.event_id }).success).toBe(false);
  });

  it("checkInSchema takes an optional note and caps its length", () => {
    const base = { event_id: crypto.randomUUID(), user_id: crypto.randomUUID() };
    expect(checkInSchema.safeParse({ ...base, note: "" }).success).toBe(true);
    expect(checkInSchema.safeParse({ ...base, note: "Guest of a member" }).success).toBe(true);
    expect(checkInSchema.safeParse({ ...base, note: "x".repeat(501) }).success).toBe(false);
  });

  it("attachCheckInSchema works with and without a chosen membership", () => {
    const id = crypto.randomUUID();
    // No membership id: re-run the same precedence the door would have applied.
    expect(attachCheckInSchema.safeParse({ id }).success).toBe(true);
    expect(attachCheckInSchema.safeParse({ id, membership_id: crypto.randomUUID() }).success).toBe(
      true,
    );
    expect(attachCheckInSchema.safeParse({ id, membership_id: "nope" }).success).toBe(false);
  });

  it("undoCheckInSchema takes the check-in, not the membership", () => {
    expect(undoCheckInSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(true);
    expect(undoCheckInSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });

  // These two lists are mirrored by CHECK constraints and stored values in the
  // `session_checkins` migration. Pinning them here means a divergence fails a
  // test rather than a production insert.
  it("pins the coverage sources and warning codes the database expects", () => {
    expect([...coverageSources]).toEqual(["trial", "session", "period", "none"]);
    expect([...checkInWarnings]).toEqual([
      "no_cover",
      "last_credit",
      "membership_ended",
      "credits_exhausted",
      "payment_pending",
      "not_started",
      "coverage_race",
    ]);
  });
});

describe("knowledge base placement and link entries", () => {
  const slug = "your-first-session";

  it("accepts a link entry that names where it points and what to call it", () => {
    const parsed = saveKbArticleSchema.parse({
      slug,
      link_path: "/first-class",
      nav_title: "Your first session",
      section: "start-here",
      position: 10,
    });
    expect(parsed.link_path).toBe("/first-class");
  });

  // A link entry has no article text to take a name from, so an unnamed one
  // would appear in the sidebar as a blank row.
  it("refuses a link entry with no nav_title", () => {
    const result = saveKbArticleSchema.safeParse({ slug, link_path: "/first-class" });
    expect(result.success).toBe(false);
  });

  it("refuses a link entry that also carries article text", () => {
    const result = saveKbArticleSchema.safeParse({
      slug,
      link_path: "/first-class",
      nav_title: "Your first session",
      title: "Your first session",
      body_md: "Turn up early.",
    });
    expect(result.success).toBe(false);
  });

  // The pattern is the security boundary, not a tidiness rule: an absolute URL
  // would put any destination into the club's own sidebar, and `//host` would
  // make /kb/<slug> an open redirect.
  it("refuses anything that is not a path on this site", () => {
    for (const link_path of [
      "https://evil.example/phish",
      "//evil.example/phish",
      "/../etc",
      "first-class",
      "javascript:alert(1)",
      "/a//b",
    ]) {
      const result = saveKbArticleSchema.safeParse({ slug, link_path, nav_title: "X" });
      expect(result.success, link_path).toBe(false);
    }
  });

  // A link entry aimed back into the knowledge base is a redirect loop with no
  // way out: /kb/<slug> full-navigates to link_path, so the tab just hangs.
  it("refuses a link entry that points back into the knowledge base", () => {
    for (const link_path of ["/kb", "/kb/", "/kb/our-history"]) {
      const result = saveKbArticleSchema.safeParse({ slug, link_path, nav_title: "X" });
      expect(result.success, link_path).toBe(false);
    }
    // A path that merely starts with the same letters is still fine.
    expect(saveKbArticleSchema.safeParse({ slug, link_path: "/kbo", nav_title: "X" }).success).toBe(
      true,
    );
  });

  // The refusal message for text-on-a-link told callers to clear link_path, and
  // the schema had no way to express that, so the advice was impossible to take.
  it("lets a link entry be turned back into an article, text and all", () => {
    expect(
      saveKbArticleSchema.safeParse({
        slug,
        link_path: "",
        title: "Your first session",
        body_md: "Turn up ten minutes early.",
      }).success,
    ).toBe(true);
  });

  // Clearing it alone would leave a row with neither a link nor a version,
  // which is invisible in the sidebar.
  it("refuses to clear link_path without the article text to replace it", () => {
    expect(saveKbArticleSchema.safeParse({ slug, link_path: "" }).success).toBe(false);
    expect(saveKbArticleSchema.safeParse({ slug, link_path: "", title: "X" }).success).toBe(false);
  });

  // Moving an article between sections must not require republishing its text.
  it("accepts a placement-only save with no title or body", () => {
    const parsed = saveKbArticleSchema.parse({ slug: "our-history", section: "about-the-club" });
    expect(parsed.title).toBeUndefined();
    expect(parsed.body_md).toBeUndefined();
  });

  // A version is written as a whole, so half of one is a save that would
  // publish a title with no body or a body with no heading.
  it("refuses a title without a body, and a body without a title", () => {
    expect(saveKbArticleSchema.safeParse({ slug: "our-history", title: "X" }).success).toBe(false);
    expect(saveKbArticleSchema.safeParse({ slug: "our-history", body_md: "X" }).success).toBe(
      false,
    );
  });

  it("takes an empty section as a real value, distinct from omitting it", () => {
    expect(saveKbArticleSchema.parse({ slug: "our-history", section: "" }).section).toBe("");
    expect(saveKbArticleSchema.parse({ slug: "our-history" }).section).toBeUndefined();
  });
});

describe("saveKbSectionSchema", () => {
  it("takes a slug on its own, so a section can be moved without renaming it", () => {
    expect(saveKbSectionSchema.parse({ slug: "belts", position: 30 })).toEqual({
      slug: "belts",
      position: 30,
    });
  });

  it("rejects a slug the database would reject", () => {
    expect(saveKbSectionSchema.safeParse({ slug: "Start Here" }).success).toBe(false);
  });
});

describe("knowledge base schemas", () => {
  const slug = "house-rules";

  it("kbSlugSchema accepts kebab-case and rejects anything needing escaping", () => {
    expect(kbSlugSchema.safeParse("house-rules").success).toBe(true);
    expect(kbSlugSchema.safeParse("plan-2027").success).toBe(true);
    for (const bad of ["House-Rules", "house rules", "house/rules", "-leading", "trailing-", ""]) {
      expect(kbSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("saveKbArticleSchema leaves visibility and annotations alone when omitted", () => {
    const parsed = saveKbArticleSchema.parse({ slug, title: "House rules", body_md: "# Rules" });
    // Not defaulted: an edit that does not mention visibility must not reset a
    // members-only article to whatever the default happens to be.
    expect(parsed.visibility).toBeUndefined();
    expect(parsed.annotations_enabled).toBeUndefined();
  });

  it("saveKbArticleSchema rejects an unknown visibility", () => {
    const input = { slug, title: "T", body_md: "B", visibility: "everyone" };
    expect(saveKbArticleSchema.safeParse(input).success).toBe(false);
  });

  it("saveKbArticleSchema requires a title and body", () => {
    expect(saveKbArticleSchema.safeParse({ slug, title: "", body_md: "B" }).success).toBe(false);
    expect(saveKbArticleSchema.safeParse({ slug, title: "T", body_md: "   " }).success).toBe(false);
  });

  it("createAnnotationSchema requires a visibility and a body", () => {
    const base = { slug, article_version: 1, body: "Worth clarifying." };
    expect(createAnnotationSchema.safeParse({ ...base, visibility: "private" }).success).toBe(true);
    expect(createAnnotationSchema.safeParse({ ...base, visibility: "shared" }).success).toBe(true);
    expect(createAnnotationSchema.safeParse(base).success).toBe(false);
    expect(
      createAnnotationSchema.safeParse({ ...base, body: "", visibility: "shared" }).success,
    ).toBe(false);
  });

  // The block anchor is optional: a note about the article as a whole has no
  // passage to hang off.
  it("createAnnotationSchema allows an annotation with no block anchor", () => {
    const parsed = createAnnotationSchema.parse({
      slug,
      article_version: 2,
      visibility: "shared",
      body: "Reads well overall.",
    });
    expect(parsed.block_id).toBeUndefined();
  });

  it("createAnnotationSchema keeps the honeypot empty", () => {
    const input = {
      slug,
      article_version: 1,
      visibility: "shared" as const,
      body: "Spam",
      hp: "http://spam.example",
    };
    expect(createAnnotationSchema.safeParse(input).success).toBe(false);
  });

  it("createAnnotationSchema requires a positive version, so an anchor is never versionless", () => {
    const base = { slug, visibility: "shared" as const, body: "b" };
    expect(createAnnotationSchema.safeParse({ ...base, article_version: 0 }).success).toBe(false);
    expect(createAnnotationSchema.safeParse(base).success).toBe(false);
  });

  it("updateAnnotationSchema changes the text and nothing else", () => {
    const parsed = updateAnnotationSchema.parse({
      id: crypto.randomUUID(),
      body: "Edited.",
      visibility: "private",
    });
    // `visibility` is dropped rather than honoured: flipping a shared thread to
    // private would take replies out of view with it.
    expect(parsed).not.toHaveProperty("visibility");
  });

  it("resolveAnnotationSchema takes an explicit boolean, so reopening is possible", () => {
    const id = crypto.randomUUID();
    expect(resolveAnnotationSchema.safeParse({ id, resolved: false }).success).toBe(true);
    expect(resolveAnnotationSchema.safeParse({ id }).success).toBe(false);
  });
});
