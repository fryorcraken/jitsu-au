import { describe, expect, it } from "vitest";
import {
  buildPaymentReference,
  computeMembershipPrice,
  deriveLifecycleStatus,
  formatCents,
  matchesMembershipReference,
  normalizeRef,
  parseMoneyToCents,
  sanitizeSurname,
  saveClubSettingsSchema,
  savePlanSchema,
  sessionDateTag,
  stableCode,
  startMembershipSchema,
} from "./validation";

describe("computeMembershipPrice", () => {
  const casual = { public_price_cents: 3000, student_price_cents: 2000 };
  const insurance = { public_price_cents: 6000, student_price_cents: null };

  it("charges the public price for non-students", () => {
    expect(computeMembershipPrice(casual, false)).toBe(3000);
  });

  it("charges the student price for students when one exists", () => {
    expect(computeMembershipPrice(casual, true)).toBe(2000);
  });

  it("falls back to the public price when the plan has no student rate", () => {
    expect(computeMembershipPrice(insurance, true)).toBe(6000);
    expect(computeMembershipPrice(insurance, false)).toBe(6000);
  });
});

describe("formatCents", () => {
  it("renders whole dollars without decimals", () => {
    expect(formatCents(24500)).toBe("$245");
    expect(formatCents(3000)).toBe("$30");
  });

  it("renders cents when present", () => {
    expect(formatCents(2050)).toBe("$20.50");
  });

  it("renders zero as Free", () => {
    expect(formatCents(0)).toBe("Free");
  });
});

describe("parseMoneyToCents", () => {
  it("parses dollar strings with symbols and commas", () => {
    expect(parseMoneyToCents("$245")).toBe(24500);
    expect(parseMoneyToCents("2,450.00")).toBe(245000);
    expect(parseMoneyToCents("20.50")).toBe(2050);
  });

  it("returns null for blank or unparseable input", () => {
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("   ")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
  });
});

describe("deriveLifecycleStatus", () => {
  const paid = (status: "active" | "expired" | "cancelled" | "pending") => ({
    status,
    kind: "period" as const,
    price_cents: 24500,
  });
  const trial = (status: "active" | "expired" | "cancelled" | "pending") => ({
    status,
    kind: "trial" as const,
    price_cents: 0,
  });
  const none = { hasApprovedWaiver: false, hasPendingWaiver: false };
  const pendingOnly = { hasApprovedWaiver: false, hasPendingWaiver: true };
  const approved = { hasApprovedWaiver: true, hasPendingWaiver: false };

  it("is lead with no waivers and no memberships", () => {
    expect(deriveLifecycleStatus({ ...none, memberships: [] })).toBe("lead");
  });

  it("is applicant when a waiver is submitted but none approved", () => {
    expect(deriveLifecycleStatus({ ...pendingOnly, memberships: [] })).toBe("applicant");
  });

  it("is visitor once a waiver is approved (trial assigned at approval)", () => {
    expect(deriveLifecycleStatus({ ...approved, memberships: [] })).toBe("visitor");
    expect(deriveLifecycleStatus({ ...approved, memberships: [trial("active")] })).toBe("visitor");
  });

  it("is member with an active paid membership", () => {
    expect(deriveLifecycleStatus({ ...approved, memberships: [paid("active")] })).toBe("member");
  });

  it("prefers member over visitor when trial and paid are both active", () => {
    expect(
      deriveLifecycleStatus({ ...approved, memberships: [trial("active"), paid("active")] }),
    ).toBe("member");
  });

  it("is lapsed when the trial has ended and nothing is active", () => {
    expect(deriveLifecycleStatus({ ...approved, memberships: [trial("expired")] })).toBe("lapsed");
  });

  it("is lapsed when a paid membership has ended and nothing is active", () => {
    expect(deriveLifecycleStatus({ ...approved, memberships: [paid("expired")] })).toBe("lapsed");
    expect(deriveLifecycleStatus({ ...none, memberships: [paid("cancelled")] })).toBe("lapsed");
  });

  it("is visitor again when something is active alongside an ended membership", () => {
    expect(
      deriveLifecycleStatus({ ...approved, memberships: [trial("active"), paid("expired")] }),
    ).toBe("visitor");
  });
});

describe("matchesMembershipReference", () => {
  const REF = "UTSJ-ABC234";

  it("matches when the reference appears in the description and the amount is exact", () => {
    expect(matchesMembershipReference(`Payment ${REF} semester`, REF, 24500, 24500)).toBe(true);
  });

  it("is case-insensitive on the reference", () => {
    expect(matchesMembershipReference("payment utsj-abc234", REF, 24500, 24500)).toBe(true);
  });

  it("does not match on a wrong amount", () => {
    expect(matchesMembershipReference(`Payment ${REF}`, REF, 24500, 3000)).toBe(false);
  });

  it("does not match when the reference is absent", () => {
    expect(matchesMembershipReference("Random deposit", REF, 24500, 24500)).toBe(false);
  });

  it("never matches an empty reference", () => {
    expect(matchesMembershipReference("anything", "", 24500, 24500)).toBe(false);
  });

  it("ignores hyphens/spaces/case on both sides (bank-format insensitive)", () => {
    // Reference stored without separators; bank narrative adds them.
    expect(matchesMembershipReference("payment mem-nguyen-7q", "MEMNGUYEN7Q", 6000, 6000)).toBe(
      true,
    );
    expect(matchesMembershipReference("MEM NGUYEN 7Q deposit", "MEMNGUYEN7Q", 6000, 6000)).toBe(
      true,
    );
  });
});

describe("normalizeRef", () => {
  it("uppercases and strips all non-alphanumerics", () => {
    expect(normalizeRef("mem-nguyen 7q!")).toBe("MEMNGUYEN7Q");
    expect(normalizeRef("")).toBe("");
  });
});

describe("sanitizeSurname", () => {
  it("uppercases and strips non-letters, truncating to 8", () => {
    expect(sanitizeSurname("O'Brien")).toBe("OBRIEN");
    expect(sanitizeSurname("Smith-Jones")).toBe("SMITHJON");
  });

  it("folds accents", () => {
    expect(sanitizeSurname("Nguyễn")).toBe("NGUYEN");
  });

  it("falls back to MEMBER when empty", () => {
    expect(sanitizeSurname("")).toBe("MEMBER");
    expect(sanitizeSurname("123 456")).toBe("MEMBER");
  });
});

describe("stableCode", () => {
  it("is deterministic for the same user id", () => {
    expect(stableCode("user-123")).toBe(stableCode("user-123"));
  });

  it("is 3 chars and usually differs between users", () => {
    const a = stableCode("11111111-1111-1111-1111-111111111111");
    const b = stableCode("22222222-2222-2222-2222-222222222222");
    expect(a).toHaveLength(3);
    expect(a).not.toBe(b);
  });
});

describe("sessionDateTag", () => {
  it("formats a date as day + 3-letter month, no leading zero", () => {
    expect(sessionDateTag("2026-12-07")).toBe("7DEC");
    expect(sessionDateTag("2026-01-17")).toBe("17JAN");
  });

  it("returns empty for malformed input", () => {
    expect(sessionDateTag("not-a-date")).toBe("");
  });
});

describe("buildPaymentReference", () => {
  const uid = "abc-123";

  it("prefixes MEM for non-session plans", () => {
    const ref = buildPaymentReference("Nguyen", uid);
    expect(ref.startsWith("MEMNGUYEN")).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(18);
  });

  it("drops MEM and appends the session date for per-session", () => {
    const ref = buildPaymentReference("Nguyen", uid, "2026-12-07");
    expect(ref.startsWith("MEM")).toBe(false);
    expect(ref.startsWith("NGUYEN")).toBe(true);
    expect(ref.endsWith("7DEC")).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(18);
  });

  it("is stable for the same member across calls", () => {
    expect(buildPaymentReference("Nguyen", uid)).toBe(buildPaymentReference("Nguyen", uid));
  });

  it("stays within 18 chars even for a long surname + session date", () => {
    const ref = buildPaymentReference("Wolfeschlegelstein", uid, "2026-12-17");
    expect(ref.length).toBeLessThanOrEqual(18);
    expect(ref.endsWith("17DEC")).toBe(true);
  });

  it("contains only uppercase alphanumerics (no separators)", () => {
    expect(buildPaymentReference("O'Brien", uid, "2026-12-07")).toMatch(/^[A-Z0-9]+$/);
  });
});

describe("startMembershipSchema", () => {
  it("accepts a non-student selection without a student number", () => {
    const r = startMembershipSchema.safeParse({ plan_code: "semester", is_student: false });
    expect(r.success).toBe(true);
  });

  it("requires a UTS student number when taking the student rate", () => {
    const r = startMembershipSchema.safeParse({ plan_code: "semester", is_student: true });
    expect(r.success).toBe(false);
  });

  it("accepts the student rate with a student number", () => {
    const r = startMembershipSchema.safeParse({
      plan_code: "semester",
      is_student: true,
      uts_student_number: "12345678",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a filled honeypot via the max(0) rule", () => {
    const r = startMembershipSchema.safeParse({
      plan_code: "semester",
      is_student: false,
      hp: "bot",
    });
    expect(r.success).toBe(false);
  });
});

describe("savePlanSchema", () => {
  const base = {
    code: "semester",
    name: "One semester",
    kind: "period" as const,
    public_price_cents: 44500,
    student_price_cents: 24500,
    duration_days: 182,
    session_credits: null,
    is_active: true,
    sort_order: 2,
  };

  it("accepts a well-formed plan", () => {
    expect(savePlanSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a code with invalid characters", () => {
    expect(savePlanSchema.safeParse({ ...base, code: "One Semester" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(savePlanSchema.safeParse({ ...base, kind: "gold" }).success).toBe(false);
  });
});

describe("saveClubSettingsSchema", () => {
  it("accepts markdown instructions", () => {
    const r = saveClubSettingsSchema.safeParse({
      invoice_payment_instructions: "**BSB** 062-000\n**Acc** 1234 5678",
    });
    expect(r.success).toBe(true);
  });

  it("accepts empty instructions", () => {
    expect(saveClubSettingsSchema.safeParse({ invoice_payment_instructions: "" }).success).toBe(
      true,
    );
  });

  it("rejects instructions over the length cap", () => {
    const r = saveClubSettingsSchema.safeParse({
      invoice_payment_instructions: "x".repeat(5001),
    });
    expect(r.success).toBe(false);
  });
});
