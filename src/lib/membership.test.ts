import { describe, expect, it } from "vitest";
import {
  buildPaymentReference,
  computeMembershipPrice,
  deriveLifecycleStatus,
  formatCents,
  haystackContainsRef,
  insuranceSelection,
  matchesMembershipReference,
  normalizeRef,
  parseMoneyToCents,
  planEditPayload,
  planEditsDiffer,
  planMembershipWindow,
  sanitizeSurname,
  saveClubSettingsSchema,
  savePlanSchema,
  sellablePlans,
  sellableWindowNotifications,
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

describe("haystackContainsRef", () => {
  it("matches a reference that appears as a whole alphanumeric token", () => {
    expect(haystackContainsRef("OSKO PAYMENT MEMSMITHAB12", "MEMSMITHAB12")).toBe(true);
    expect(haystackContainsRef("MEMSMITHAB12 deposit", "MEMSMITHAB12")).toBe(true);
    expect(haystackContainsRef("MEM-SMITH-AB12", "MEMSMITHAB12")).toBe(false);
  });

  it("does not match when the reference is a prefix or suffix of a longer token", () => {
    expect(haystackContainsRef("OSKO PAYMENT MEMSMITHAB123", "MEMSMITHAB12")).toBe(false);
    expect(haystackContainsRef("OSKO PAYMENT XMEMSMITHAB12", "MEMSMITHAB12")).toBe(false);
    expect(haystackContainsRef("OSKO PAYMENT MEMSMITHAB12", "MEMSMITHAB123")).toBe(false);
  });

  it("returns false when the reference is absent", () => {
    expect(haystackContainsRef("Random deposit", "MEMSMITHAB12")).toBe(false);
    expect(haystackContainsRef("", "MEMSMITHAB12")).toBe(false);
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

  it("keeps MEM and appends a window tag for a dated plan", () => {
    const ref = buildPaymentReference("Nguyen", uid, undefined, "2026-07-20");
    expect(ref.startsWith("MEMNGUYEN")).toBe(true);
    expect(ref.endsWith("JUL26")).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(18);
  });

  it("distinguishes two dated plans for the same member", () => {
    const s1 = buildPaymentReference("Nguyen", uid, undefined, "2026-07-20");
    const s2 = buildPaymentReference("Nguyen", uid, undefined, "2027-02-22");
    expect(s1).not.toBe(s2);
  });

  it("ignores the window's start date once a session date is given", () => {
    // sessionDate takes precedence -- a plan is either per-session or
    // window-dated, never both, but the tag priority must still be
    // deterministic if both were ever passed.
    const ref = buildPaymentReference("Nguyen", uid, "2026-12-07", "2026-07-20");
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
});

describe("savePlanSchema", () => {
  const base = {
    code: "semester_2_2026",
    name: "Semester 2 2026",
    kind: "period" as const,
    public_price_cents: 44500,
    student_price_cents: 24500,
    duration_days: null,
    session_credits: null,
    is_active: true,
    sort_order: 2,
    starts_on: "2026-07-20",
    ends_on: "2026-12-16",
  };

  it("accepts a well-formed dated plan", () => {
    expect(savePlanSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a well-formed rolling plan", () => {
    const rolling = {
      ...base,
      code: "insurance_yearly",
      duration_days: 365,
      starts_on: null,
      ends_on: null,
    };
    expect(savePlanSchema.safeParse(rolling).success).toBe(true);
  });

  it("accepts a plan with neither dates nor duration (trial/casual)", () => {
    const undated = { ...base, code: "casual_session", starts_on: null, ends_on: null };
    expect(savePlanSchema.safeParse(undated).success).toBe(true);
  });

  it("rejects a code with invalid characters", () => {
    expect(savePlanSchema.safeParse({ ...base, code: "One Semester" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(savePlanSchema.safeParse({ ...base, kind: "gold" }).success).toBe(false);
  });

  it("rejects starts_on without ends_on, or vice versa", () => {
    expect(savePlanSchema.safeParse({ ...base, ends_on: null }).success).toBe(false);
    expect(savePlanSchema.safeParse({ ...base, starts_on: null }).success).toBe(false);
  });

  it("rejects an end date before the start date", () => {
    const r = savePlanSchema.safeParse({
      ...base,
      starts_on: "2026-12-16",
      ends_on: "2026-07-20",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a same-day plan (start equals end)", () => {
    expect(savePlanSchema.safeParse({ ...base, ends_on: base.starts_on }).success).toBe(true);
  });

  it("rejects both a date range and a rolling duration on the same plan", () => {
    const r = savePlanSchema.safeParse({ ...base, duration_days: 365 });
    expect(r.success).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(savePlanSchema.safeParse({ ...base, starts_on: "2/2/2026" }).success).toBe(false);
  });
});

describe("planMembershipWindow", () => {
  const NOW = "2026-05-01T00:00:00.000Z";

  it("starts at 00:00 Australia/Sydney on starts_on for a dated plan", () => {
    const w = planMembershipWindow(
      { starts_on: "2026-07-20", ends_on: "2026-11-22", duration_days: null },
      NOW,
    );
    // AEST (+10) in July, no daylight saving.
    expect(w.starts_at).toBe("2026-07-19T14:00:00.000Z");
  });

  it("ends at 23:59:59 Australia/Sydney on ends_on, inclusive", () => {
    const w = planMembershipWindow(
      { starts_on: "2026-07-20", ends_on: "2026-11-22", duration_days: null },
      NOW,
    );
    // AEDT (+11) by late November.
    expect(w.ends_at).toBe("2026-11-22T12:59:59.000Z");
  });

  it("survives the April daylight-saving boundary (Semester 1's end)", () => {
    // 2026-04-05 02:00 AEDT is when clocks fall back to AEST in Sydney.
    const w = planMembershipWindow(
      { starts_on: "2026-02-02", ends_on: "2026-04-05", duration_days: null },
      NOW,
    );
    expect(w.starts_at).toBe("2026-02-01T13:00:00.000Z"); // AEDT (+11) in February
    expect(w.ends_at).toBe("2026-04-05T13:59:59.000Z"); // AEST (+10) once fallen back
  });

  it("survives the October daylight-saving boundary (Semester 2's start)", () => {
    // 2026-10-04 02:00 AEST is when clocks spring forward to AEDT in Sydney.
    const w = planMembershipWindow(
      { starts_on: "2026-10-04", ends_on: "2026-11-22", duration_days: null },
      NOW,
    );
    expect(w.starts_at).toBe("2026-10-03T14:00:00.000Z"); // still AEST (+10) at 00:00 on the 4th
  });

  it("runs a rolling plan from now for duration_days", () => {
    const w = planMembershipWindow({ starts_on: null, ends_on: null, duration_days: 365 }, NOW);
    expect(w.starts_at).toBe(NOW);
    expect(w.ends_at).toBe("2027-05-01T00:00:00.000Z");
  });

  it("has no expiry at all with neither dates nor a duration", () => {
    const w = planMembershipWindow({ starts_on: null, ends_on: null, duration_days: null }, NOW);
    expect(w.starts_at).toBe(NOW);
    expect(w.ends_at).toBeNull();
  });
});

describe("sellablePlans", () => {
  const dated = (overrides: Partial<Record<string, unknown>> = {}) => ({
    code: "semester_2_2026",
    starts_on: "2026-07-20",
    ends_on: "2026-11-22",
    duration_days: null,
    is_active: true,
    ...overrides,
  });
  const undated = (overrides: Partial<Record<string, unknown>> = {}) => ({
    code: "casual_session",
    starts_on: null,
    ends_on: null,
    duration_days: null,
    is_active: true,
    ...overrides,
  });

  it("keeps a still-running dated plan", () => {
    const offered = sellablePlans([dated()], "2026-08-01T00:00:00.000Z");
    expect(offered.map((p) => p.code)).toEqual(["semester_2_2026"]);
  });

  it("keeps a not-yet-started dated plan (pre-sale)", () => {
    const offered = sellablePlans(
      [dated({ starts_on: "2027-02-22", ends_on: "2027-06-25" })],
      "2026-08-01T00:00:00.000Z",
    );
    expect(offered).toHaveLength(1);
  });

  it("drops a dated plan once its ends_on has passed", () => {
    const offered = sellablePlans([dated()], "2026-12-01T00:00:00.000Z");
    expect(offered).toEqual([]);
  });

  it("ignores an inactive (retired) plan regardless of its dates", () => {
    const offered = sellablePlans([dated({ is_active: false })], "2026-08-01T00:00:00.000Z");
    expect(offered).toEqual([]);
  });

  it("always keeps an undated plan while active", () => {
    const offered = sellablePlans([undated()], "2026-12-01T00:00:00.000Z");
    expect(offered).toEqual([undated()]);
  });

  it("is inclusive of the plan's own last day", () => {
    // 2026-11-22T10:00 UTC is still 22 Nov in Sydney (AEDT, +11).
    expect(sellablePlans([dated()], "2026-11-22T10:00:00.000Z")).toHaveLength(1);
  });
});

describe("insuranceSelection", () => {
  const NOW = "2026-08-03T10:00:00.000Z";

  it("preselects and forbids deselect when there is no cover at all", () => {
    const sel = insuranceSelection({ insuranceEndsAt: null, now: NOW });
    expect(sel).toEqual({ preselect: true, canDeselect: false });
  });

  it("treats lapsed cover like none at all", () => {
    const sel = insuranceSelection({ insuranceEndsAt: "2026-01-01T00:00:00Z", now: NOW });
    expect(sel).toEqual({ preselect: true, canDeselect: false });
  });

  it("leaves the tick alone and deselectable when cover runs well past the window", () => {
    const sel = insuranceSelection({ insuranceEndsAt: "2026-12-31T00:00:00Z", now: NOW });
    expect(sel).toEqual({ preselect: false, canDeselect: true });
  });

  it("preselects but does not force when cover lapses inside the 30-day window", () => {
    const sel = insuranceSelection({ insuranceEndsAt: "2026-08-20T00:00:00Z", now: NOW });
    expect(sel).toEqual({ preselect: true, canDeselect: true });
  });

  it("honours a custom horizon the same way", () => {
    const sel = insuranceSelection({
      insuranceEndsAt: "2026-08-20T00:00:00Z",
      now: NOW,
      daysAhead: 60,
    });
    expect(sel.preselect).toBe(true);
  });
});

describe("sellableWindowNotifications", () => {
  const w = (name: string, ends_on: string, is_active = true) => ({
    name,
    ends_on,
    starts_on: "2026-01-01",
    is_active,
  });
  const NOW = "2026-08-03T10:00:00.000Z";

  it("asks for the first plan when no dated plan exists", () => {
    const n = sellableWindowNotifications([], NOW);
    expect(n).toHaveLength(1);
    expect(n[0].type).toBe("define_membership_window");
    expect(n[0].title).toMatch(/set up/i);
  });

  it("asks for the next plan when the latest one ends inside 30 days", () => {
    const n = sellableWindowNotifications([w("Semester 2 2026", "2026-08-20")], NOW);
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain("Semester 2 2026");
  });

  it("stays quiet while a still-running plan plus its successor are both defined", () => {
    // Current plan ends soon, but the successor pushes the horizon out.
    const n = sellableWindowNotifications(
      [w("Semester 2 2026", "2026-08-20"), w("Semester 1 2027", "2027-06-15")],
      NOW,
    );
    expect(n).toEqual([]);
  });

  it("stays quiet when the latest plan ends well past 30 days away", () => {
    expect(sellableWindowNotifications([w("Semester 2 2026", "2026-12-16")], NOW)).toEqual([]);
  });

  it("treats an already-ended latest plan as urgent", () => {
    const n = sellableWindowNotifications([w("Semester 1 2026", "2026-06-12")], NOW);
    expect(n).toHaveLength(1);
  });

  it("ignores retired (inactive) plans when judging the latest end", () => {
    const n = sellableWindowNotifications([w("Semester 2 2026", "2026-08-20", false)], NOW);
    expect(n).toHaveLength(1);
    expect(n[0].title).toMatch(/set up/i);
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

describe("planEditPayload / planEditsDiffer", () => {
  const plan = () => ({
    id: "11111111-1111-4111-8111-111111111111",
    code: "2026-s2",
    name: "Semester 2 2026",
    description: "Unlimited classes",
    kind: "period",
    public_price_cents: 44500,
    student_price_cents: 24500,
    duration_days: null,
    session_credits: null,
    is_active: true,
    sort_order: 2,
    starts_on: "2026-07-20",
    ends_on: "2026-12-16",
  });

  it("passes the editable fields through and normalises a null description", () => {
    expect(planEditPayload({ ...plan(), description: null })).toEqual({
      ...plan(),
      description: "",
    });
  });

  it("omits id when creating rather than sending an undefined one", () => {
    const { id: _id, ...rest } = plan();
    expect("id" in planEditPayload(rest)).toBe(false);
  });

  it("reports no difference for an untouched copy", () => {
    expect(planEditsDiffer(plan(), plan())).toBe(false);
  });

  it("ignores fields a save does not carry, so they cannot fake a change", () => {
    // `created_at` rides along on the row but is never sent.
    const withExtra = { ...plan(), created_at: "2026-01-01T00:00:00Z" };
    expect(planEditsDiffer(withExtra, plan())).toBe(false);
  });

  it.each([
    ["name", { name: "Semester 2 2026 (revised)" }],
    ["price", { public_price_cents: 45000 }],
    ["kind", { kind: "session" }],
    ["dates", { ends_on: "2026-12-20" }],
    ["availability", { is_active: false }],
    ["credits", { session_credits: 10 }],
  ])("reports a difference when the %s changes", (_label, patch) => {
    expect(planEditsDiffer({ ...plan(), ...patch }, plan())).toBe(true);
  });

  it("treats an empty-string description as equal to a null one", () => {
    expect(planEditsDiffer({ ...plan(), description: "" }, { ...plan(), description: null })).toBe(
      false,
    );
  });
});
