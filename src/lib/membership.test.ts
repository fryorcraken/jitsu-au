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
  saveSemesterSchema,
  sellableSemesters,
  semesterMembershipWindow,
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

  it("keeps MEM and appends a semester tag for a semester-anchored plan", () => {
    const ref = buildPaymentReference("Nguyen", uid, undefined, "2026-s1");
    expect(ref.startsWith("MEMNGUYEN")).toBe(true);
    expect(ref.endsWith("S126")).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(18);
  });

  it("distinguishes two semesters for the same member", () => {
    const s1 = buildPaymentReference("Nguyen", uid, undefined, "2026-s1");
    const s2 = buildPaymentReference("Nguyen", uid, undefined, "2026-s2");
    expect(s1).not.toBe(s2);
  });

  it("ignores the semester code once a session date is given", () => {
    // sessionDate takes precedence -- a plan is either per-session or
    // semester-anchored, never both, but the tag priority must still be
    // deterministic if both were ever passed.
    const ref = buildPaymentReference("Nguyen", uid, "2026-12-07", "2026-s1");
    expect(ref.endsWith("7DEC")).toBe(true);
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

  it("accepts an omitted semester_code (only meaningful for a semester plan)", () => {
    const r = startMembershipSchema.safeParse({ plan_code: "casual_session", is_student: false });
    expect(r.success).toBe(true);
  });

  it("accepts a semester_code alongside a semester plan", () => {
    const r = startMembershipSchema.safeParse({
      plan_code: "semester",
      is_student: false,
      semester_code: "2026-s2",
    });
    expect(r.success).toBe(true);
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
    period_basis: "semester" as const,
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

  it("rejects an unknown period_basis", () => {
    expect(savePlanSchema.safeParse({ ...base, period_basis: "termly" }).success).toBe(false);
  });

  it("accepts a rolling plan (e.g. the yearly insurance membership)", () => {
    expect(
      savePlanSchema.safeParse({ ...base, code: "insurance_yearly", period_basis: "rolling" })
        .success,
    ).toBe(true);
  });
});

describe("saveSemesterSchema", () => {
  const base = {
    year: 2026,
    half: 1 as const,
    name: "Semester 1 2026",
    starts_on: "2026-02-02",
    ends_on: "2026-06-28",
  };

  it("accepts a well-formed semester", () => {
    expect(saveSemesterSchema.safeParse(base).success).toBe(true);
  });

  it("accepts half 2", () => {
    expect(saveSemesterSchema.safeParse({ ...base, half: 2 }).success).toBe(true);
  });

  it("rejects a half outside 1 or 2", () => {
    expect(saveSemesterSchema.safeParse({ ...base, half: 3 }).success).toBe(false);
  });

  it("rejects an end date before the start date", () => {
    const r = saveSemesterSchema.safeParse({
      ...base,
      starts_on: "2026-06-28",
      ends_on: "2026-02-02",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a same-day semester (start equals end)", () => {
    expect(saveSemesterSchema.safeParse({ ...base, ends_on: base.starts_on }).success).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(saveSemesterSchema.safeParse({ ...base, starts_on: "2/2/2026" }).success).toBe(false);
  });

  it("is_active may be omitted", () => {
    const r = saveSemesterSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.is_active).toBeUndefined();
  });
});

describe("semesterMembershipWindow", () => {
  it("starts at 00:00 Australia/Sydney on starts_on", () => {
    const w = semesterMembershipWindow({ starts_on: "2026-07-20", ends_on: "2026-11-22" });
    // AEST (+10) in July, no daylight saving.
    expect(w.starts_at).toBe("2026-07-19T14:00:00.000Z");
  });

  it("ends at 23:59:59 Australia/Sydney on ends_on, inclusive", () => {
    const w = semesterMembershipWindow({ starts_on: "2026-07-20", ends_on: "2026-11-22" });
    // AEDT (+11) by late November.
    expect(w.ends_at).toBe("2026-11-22T12:59:59.000Z");
  });

  it("survives the April daylight-saving boundary (Semester 1's end)", () => {
    // 2026-04-05 02:00 AEDT is when clocks fall back to AEST in Sydney.
    const w = semesterMembershipWindow({ starts_on: "2026-02-02", ends_on: "2026-04-05" });
    expect(w.starts_at).toBe("2026-02-01T13:00:00.000Z"); // AEDT (+11) in February
    expect(w.ends_at).toBe("2026-04-05T13:59:59.000Z"); // AEST (+10) once fallen back
  });

  it("survives the October daylight-saving boundary (Semester 2's start)", () => {
    // 2026-10-04 02:00 AEST is when clocks spring forward to AEDT in Sydney.
    const w = semesterMembershipWindow({ starts_on: "2026-10-04", ends_on: "2026-11-22" });
    expect(w.starts_at).toBe("2026-10-03T14:00:00.000Z"); // still AEST (+10) at 00:00 on the 4th
  });
});

describe("sellableSemesters", () => {
  const s1 = {
    code: "2026-s1",
    starts_on: "2026-02-02",
    ends_on: "2026-06-28",
    is_active: true,
  };
  const s2 = {
    code: "2026-s2",
    starts_on: "2026-07-20",
    ends_on: "2026-11-22",
    is_active: true,
  };
  const all = [s1, s2];

  it("offers the running semester plus the next one", () => {
    // Inside s1's window.
    const offered = sellableSemesters(all, "2026-03-01T00:00:00.000Z");
    expect(offered.map((s) => s.code)).toEqual(["2026-s1", "2026-s2"]);
  });

  it("offers only the next semester during a break, not the one just finished", () => {
    // The winter break between s1 and s2.
    const offered = sellableSemesters(all, "2026-07-01T00:00:00.000Z");
    expect(offered.map((s) => s.code)).toEqual(["2026-s2"]);
  });

  it("offers nothing once the last configured semester has ended", () => {
    const offered = sellableSemesters(all, "2026-12-01T00:00:00.000Z");
    expect(offered).toEqual([]);
  });

  it("ignores an inactive (retired) semester", () => {
    const offered = sellableSemesters(
      [s1, { ...s2, is_active: false }],
      "2026-08-01T00:00:00.000Z",
    );
    expect(offered).toEqual([]);
  });

  it("is inclusive of the semester's own start and end days", () => {
    expect(sellableSemesters(all, "2026-02-02T00:00:00.000Z").map((s) => s.code)).toContain(
      "2026-s1",
    );
    // 2026-06-28T10:00 UTC is still 28 June in Sydney (AEST, +10).
    expect(sellableSemesters(all, "2026-06-28T10:00:00.000Z").map((s) => s.code)).toContain(
      "2026-s1",
    );
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
