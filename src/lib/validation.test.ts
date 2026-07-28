import { describe, expect, it } from "vitest";
import {
  buildSignerMeta,
  composeFullName,
  contactSchema,
  decodeDataUrlPng,
  deriveWaiverListStatuses,
  interestSchema,
  isUtsStudent,
  normalizeEmail,
  profileFullName,
  resolveNamePrefill,
  saveTemplateSchema,
  splitFullName,
  waiverApprovalSchema,
  waiverPrefillSearchSchema,
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
      emergency_contact_phone: "0400 111 111",
      medical_notes: "None",
      is_minor: false,
      guardian_name: null,
      guardian_relationship: null,
    };
    // Feed it a row with extra waiver-only keys; they must not leak through.
    const patch = waiverToProfileFields({
      ...fields,
      pdf_path: "x.pdf",
      signer_ip: "203.0.113.7",
      email: "ada@example.com",
    } as never);
    expect(patch).toEqual(fields);
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
});

describe("waiverSubmitSchema", () => {
  const validAdult = {
    first_name: "Ada",
    last_name: "Lovelace",
    date_of_birth: "1990-12-10",
    address: "1 Broadway, Ultimo NSW",
    phone: "0400000000",
    email: "ada@example.com",
    emergency_contact_name: "Charles Babbage",
    emergency_contact_phone: "0400000001",
    signature_name: "Ada Lovelace",
  };

  it("accepts a valid adult waiver with a typed signature", () => {
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
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

  it("defaults is_minor to false when omitted", () => {
    const result = waiverSubmitSchema.safeParse(validAdult);
    expect(result.success && result.data.is_minor).toBe(false);
  });

  it("requires guardian details for a minor", () => {
    const result = waiverSubmitSchema.safeParse({ ...validAdult, is_minor: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("guardian_name"))).toBe(true);
    }
  });

  it("accepts a minor with full guardian details and signature", () => {
    const result = waiverSubmitSchema.safeParse({
      ...validAdult,
      is_minor: true,
      guardian_name: "Charles Babbage",
      guardian_relationship: "Father",
      guardian_signature: "Charles Babbage",
    });
    expect(result.success).toBe(true);
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
