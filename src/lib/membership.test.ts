import { describe, expect, it } from "vitest";
import {
  buildPaymentReference,
  clubPaymentDetailsSchema,
  clubPaymentFieldValue,
  computeMembershipPrice,
  createMembershipSchema,
  deriveLifecycleStatus,
  formatBsb,
  formatCents,
  hasInternationalDetails,
  parseClubPaymentDetails,
  haystackContainsRef,
  insuranceSelection,
  matchesMembershipReference,
  isUnpaid,
  membershipDeleteMessage,
  normalizeRef,
  whyMembershipCannotBeDeleted,
  parseMoneyToCents,
  planEditPayload,
  planEditsDiffer,
  planShapeError,
  planShapeUnchanged,
  planTypePatch,
  strandedPlanFields,
  planMembershipWindow,
  sanitizeSurname,
  savePlanSchema,
  sellablePlans,
  sellableWindowNotifications,
  sessionDateTag,
  stableCode,
  startMembershipSchema,
  unpaidInvoices,
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

// Deleting a membership is the only irreversible thing a manager can do to one,
// so the guard is where the care goes. The rule that matters most: it reports
// EVERY blocker, because clearing one and being refused by the next is how a
// manager ends up deciding the screen is broken.
describe("whyMembershipCannotBeDeleted", () => {
  const junk = { paid_at: null, checkin_count: 0 };

  it("lets an unpaid invoice nobody trained on go", () => {
    expect(whyMembershipCannotBeDeleted(junk)).toEqual([]);
  });

  it("blocks one that has been paid", () => {
    expect(whyMembershipCannotBeDeleted({ ...junk, paid_at: "2026-08-01T00:00:00Z" })).toEqual([
      "paid",
    ]);
  });

  // session_checkins.membership_id is ON DELETE SET NULL, so without this guard
  // the delete would succeed and silently turn a covered class into an
  // uncovered one rather than failing.
  it("blocks one somebody trained on", () => {
    expect(whyMembershipCannotBeDeleted({ ...junk, checkin_count: 1 })).toEqual(["attended"]);
  });

  it("reports every blocker at once, not the first one found", () => {
    expect(
      whyMembershipCannotBeDeleted({ paid_at: "2026-08-01T00:00:00Z", checkin_count: 3 }),
    ).toEqual(["paid", "attended"]);
  });

  // The whole reason authorising and paying were separated. Being authorised
  // is now the normal state of every membership from the moment it is raised,
  // so if it blocked deletion nothing would ever be deletable without a cancel
  // first — and `paid_at` used to be written by that same act, which is what
  // made a hand-authorised membership permanently undeletable.
  it("does not care whether it is active, only whether it was paid for", () => {
    expect(whyMembershipCannotBeDeleted(junk)).toEqual([]);
    expect(whyMembershipCannotBeDeleted({ paid_at: null, checkin_count: 0 })).toEqual([]);
  });
});

describe("membershipDeleteMessage", () => {
  it("says nothing when there is nothing in the way", () => {
    expect(membershipDeleteMessage([])).toBe("");
  });

  it("names the reason and what to do about it", () => {
    const msg = membershipDeleteMessage(["attended"]);
    expect(msg).toContain("a class was checked in against it");
    expect(msg).toContain("move those check-ins");
  });

  // The blocker nobody can clear decides the advice on its own: there is no
  // sequence of steps that ends in a settled invoice being deleted, so sending
  // them off to move check-ins first would be a wasted trip.
  it("tells a manager to cancel a paid one rather than listing steps", () => {
    const msg = membershipDeleteMessage(["paid", "attended"]);
    expect(msg).toContain("Cancel it instead");
    expect(msg).not.toContain("To delete it");
  });

  it("reads as a sentence with every reason in it", () => {
    const msg = membershipDeleteMessage(["paid", "attended"]);
    expect(msg).toContain("a payment is recorded against it and a class was checked in against it");
  });
});

// One definition of "unpaid", shared by the member's invoice list, the
// reconciliation screen, the check-in warning and the delete guard. It reads
// `paid_at` and never `status`, because status is about permission to train.
describe("isUnpaid", () => {
  const owed = { status: "active", paid_at: null, price_cents: 44500 };

  it("is unpaid while no payment has been recorded", () => {
    expect(isUnpaid(owed)).toBe(true);
  });

  it("is paid once a payment is recorded", () => {
    expect(isUnpaid({ ...owed, paid_at: "2026-08-01T00:00:00Z" })).toBe(false);
  });

  // A withdrawn invoice is owed nothing. Chasing somebody for one a manager
  // cancelled is worse than not chasing at all.
  it("owes nothing on a cancelled membership", () => {
    expect(isUnpaid({ ...owed, status: "cancelled" })).toBe(false);
  });

  // The rows that predate the split still say `pending`, and they are unpaid in
  // exactly the same way as everything else.
  it("still reads a legacy pending row as unpaid", () => {
    expect(isUnpaid({ ...owed, status: "pending" })).toBe(true);
  });

  // Nothing records a payment against $0, so a free membership's `paid_at` is
  // null for ever. Without the price test that made every auto-assigned trial a
  // standing invoice: the member's own page showed them the club's bank details
  // and a payment reference for something the club had given them, with no
  // action anywhere that could clear it.
  it("never owes anything on a free membership, however long it goes unpaid", () => {
    expect(isUnpaid({ ...owed, price_cents: 0 })).toBe(false);
    expect(isUnpaid({ status: "active", paid_at: null, price_cents: 0 })).toBe(false);
  });
});

// A manager raising somebody's invoice, as opposed to a member raising their
// own. The two fields that differ carry the whole difference.
describe("createMembershipSchema", () => {
  const base = { user_id: "11111111-1111-4111-8111-111111111111", plan_code: "2026-s2" };

  it("emails them by default, because most of the time they owe money", () => {
    expect(createMembershipSchema.parse(base).send_email).toBe(true);
  });

  it("lets a manager record a backfill without invoicing anyone", () => {
    expect(createMembershipSchema.parse({ ...base, send_email: false }).send_email).toBe(false);
  });

  // Unlike the member's own purchase, where leaving insurance off is refused
  // when they have no cover, a manager's answer stands.
  it("leaves insurance off unless it is asked for", () => {
    expect(createMembershipSchema.parse(base).include_insurance).toBe(false);
  });

  it("needs a real person to raise it against", () => {
    expect(() => createMembershipSchema.parse({ ...base, user_id: "someone" })).toThrow();
  });

  it("rejects a session date that is not a date", () => {
    expect(() => createMembershipSchema.parse({ ...base, session_date: "7 Dec" })).toThrow();
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
    const r = startMembershipSchema.safeParse({
      plan_code: "semester",
      is_student: false,
      hp: "",
    });
    expect(r.success).toBe(true);
  });

  it("requires a UTS student number when taking the student rate", () => {
    const r = startMembershipSchema.safeParse({ plan_code: "semester", is_student: true, hp: "" });
    expect(r.success).toBe(false);
  });

  it("accepts the student rate with a student number", () => {
    const r = startMembershipSchema.safeParse({
      plan_code: "semester",
      is_student: true,
      uts_student_number: "12345678",
      hp: "",
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

  it("rejects a selection that omits the honeypot", () => {
    // `hp` is required, so a request that never had a form behind it fails
    // here rather than starting a membership.
    const r = startMembershipSchema.safeParse({ plan_code: "semester", is_student: false });
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

  // The club's own dated plans use hyphens: their codes were copied from
  // `club_semesters`, whose CHECK mandated '^[0-9]{4}-s[12]$'. The manager
  // screen renders no Code field, so it echoes the stored code back on every
  // save — a hyphen-rejecting regex made those plans unsaveable outright.
  it("accepts the club's hyphenated semester codes", () => {
    for (const code of ["2026-s1", "2026-s2"]) {
      expect(savePlanSchema.safeParse({ ...base, code }).success).toBe(true);
    }
  });

  it("still rejects codes with spaces, capitals or punctuation", () => {
    for (const code of ["Semester 1", "2026 s1", "2026.s1", "SEMESTER"]) {
      expect(savePlanSchema.safeParse({ ...base, code }).success).toBe(false);
    }
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

  // Undated plans (the free trial, casual classes) run from the START OF THE
  // CLUB DAY, so the row reads as "granted on this day" rather than at some
  // arbitrary instant. Nothing enforces it -- a credit balance is not date-gated
  // at check-in -- but the value is still pinned so the day grain does not drift
  // back to a raw timestamp unnoticed. NOW is 10:00 Sydney on 1 May, so the
  // day's midnight is the previous afternoon in UTC.
  it("runs an undated plan from the start of the club day, with no expiry", () => {
    const w = planMembershipWindow({ starts_on: null, ends_on: null, duration_days: null }, NOW);
    expect(w.starts_at).toBe("2026-04-30T14:00:00.000Z");
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

describe("unpaidInvoices", () => {
  // Authorised and unpaid, which is what every membership looks like the moment
  // it is raised.
  const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: "m1",
    status: "active",
    paid_at: null,
    plan_name: "Semester 2 2026",
    price_cents: 24500,
    payment_reference: "UTSJ-LOVE-A1B2",
    ...overrides,
  });

  it("returns nothing when everything is settled or withdrawn", () => {
    expect(
      unpaidInvoices([
        row({ paid_at: "2026-08-01T00:00:00Z" }),
        row({ id: "m2", status: "cancelled" }),
      ]),
    ).toEqual([]);
  });

  // Being authorised is not being paid up. This is the case that would break
  // silently if "unpaid" went back to meaning `status === "pending"`: every
  // membership is active now, so the member would be shown nothing to pay.
  it("bills an authorised membership that has not been paid for", () => {
    expect(unpaidInvoices([row()])).toEqual([
      {
        reference: "UTSJ-LOVE-A1B2",
        total_cents: 24500,
        lines: [{ membership_id: "m1", plan_name: "Semester 2 2026", price_cents: 24500 }],
      },
    ]);
  });

  it("adds up a bundle sharing one reference into ONE transfer", () => {
    // Buying a plan with insurance writes two memberships against one
    // reference. The member owes one payment, and the total has to match the
    // one the invoice email quotes.
    const invoices = unpaidInvoices([
      row(),
      row({ id: "m2", plan_name: "Yearly insurance", price_cents: 6000 }),
    ]);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].total_cents).toBe(30500);
    expect(invoices[0].lines.map((l) => l.plan_name)).toEqual([
      "Semester 2 2026",
      "Yearly insurance",
    ]);
  });

  it("keeps separate references apart, in the order given", () => {
    const invoices = unpaidInvoices([
      row({ id: "m2", plan_name: "Casual class", price_cents: 2000, payment_reference: "UTSJ-B" }),
      row(),
    ]);
    expect(invoices.map((i) => i.reference)).toEqual(["UTSJ-B", "UTSJ-LOVE-A1B2"]);
    expect(invoices.map((i) => i.total_cents)).toEqual([2000, 24500]);
  });

  it("ignores an already-paid membership sharing the reference", () => {
    // Half a bundle settled on its own (a manager marking one row paid by hand)
    // must not be re-billed: only what is still owed is owed.
    const invoices = unpaidInvoices([
      row({ paid_at: "2026-08-01T00:00:00Z" }),
      row({ id: "m2", plan_name: "Yearly insurance", price_cents: 6000 }),
    ]);
    expect(invoices).toEqual([
      {
        reference: "UTSJ-LOVE-A1B2",
        total_cents: 6000,
        lines: [{ membership_id: "m2", plan_name: "Yearly insurance", price_cents: 6000 }],
      },
    ]);
  });

  it("still bills a line whose plan could not be resolved", () => {
    expect(unpaidInvoices([row({ plan_name: null })])[0].lines[0].plan_name).toBeNull();
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

  it("labels its button 'Fix it' — unset training dates really are a fault", () => {
    // The label used to be hardcoded in the dashboard, which made it wrong for
    // any notification that is not a fault. It now travels with the item, so
    // this one has to keep asserting the verb it always showed.
    expect(sellableWindowNotifications([], NOW)[0].actionLabel).toBe("Fix it");
    expect(
      sellableWindowNotifications([w("Semester 2 2026", "2026-08-20")], NOW)[0].actionLabel,
    ).toBe("Fix it");
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

describe("clubPaymentDetailsSchema", () => {
  const account = (overrides: Record<string, unknown> = {}) => ({
    account_name: "UTS Jitsu Club Inc",
    bsb: "062-000",
    account_number: "12345678",
    bank_name: "Commonwealth Bank of Australia",
    ...overrides,
  });

  it("accepts an account with only the four required fields", () => {
    const r = clubPaymentDetailsSchema.safeParse(account());
    expect(r.success).toBe(true);
    // The optional fields settle to "" rather than undefined, so every renderer
    // can read them without a null check.
    expect(r.success && r.data.swift_bic).toBe("");
    expect(r.success && r.data.note).toBe("");
  });

  it("stores a BSB as six digits however it was typed", () => {
    for (const typed of ["062-000", "062000", "062 000"]) {
      const r = clubPaymentDetailsSchema.safeParse(account({ bsb: typed }));
      expect(r.success && r.data.bsb).toBe("062000");
    }
  });

  it("rejects a BSB that is not six digits", () => {
    expect(clubPaymentDetailsSchema.safeParse(account({ bsb: "06200" })).success).toBe(false);
    expect(clubPaymentDetailsSchema.safeParse(account({ bsb: "0620001" })).success).toBe(false);
    expect(clubPaymentDetailsSchema.safeParse(account({ bsb: "abcdef" })).success).toBe(false);
  });

  it("strips spaces from an account number and rejects a non-numeric one", () => {
    const spaced = clubPaymentDetailsSchema.safeParse(account({ account_number: "1234 5678" }));
    expect(spaced.success && spaced.data.account_number).toBe("12345678");
    expect(clubPaymentDetailsSchema.safeParse(account({ account_number: "12-34" })).success).toBe(
      false,
    );
    expect(clubPaymentDetailsSchema.safeParse(account({ account_number: "123" })).success).toBe(
      false,
    );
  });

  // A half-filled account is worse than none: it looks payable, and somebody
  // copies what is there and guesses the rest.
  it("refuses a partly filled account", () => {
    for (const missing of ["account_name", "bsb", "account_number", "bank_name"] as const) {
      expect(clubPaymentDetailsSchema.safeParse(account({ [missing]: "" })).success).toBe(false);
    }
  });

  // 8 or 11 characters, never 9 or 10: the branch part is three characters or
  // it is absent.
  it("accepts an 8 or 11 character SWIFT/BIC and rejects the shapes in between", () => {
    expect(clubPaymentDetailsSchema.safeParse(account({ swift_bic: "CTBAAU2S" })).success).toBe(
      true,
    );
    expect(clubPaymentDetailsSchema.safeParse(account({ swift_bic: "CTBAAU2SXXX" })).success).toBe(
      true,
    );
    expect(clubPaymentDetailsSchema.safeParse(account({ swift_bic: "CTBAAU2SX" })).success).toBe(
      false,
    );
    expect(clubPaymentDetailsSchema.safeParse(account({ swift_bic: "12BAAU2S" })).success).toBe(
      false,
    );
  });

  it("uppercases a SWIFT/BIC and treats blank as simply not given", () => {
    const r = clubPaymentDetailsSchema.safeParse(account({ swift_bic: "ctbaau2s" }));
    expect(r.success && r.data.swift_bic).toBe("CTBAAU2S");
    expect(clubPaymentDetailsSchema.safeParse(account({ swift_bic: "" })).success).toBe(true);
  });
});

describe("formatBsb", () => {
  it("hyphenates six digits the way every Australian bank prints them", () => {
    expect(formatBsb("062000")).toBe("062-000");
  });

  it("leaves anything that is not six digits alone rather than mangling it", () => {
    expect(formatBsb("06200")).toBe("06200");
    expect(formatBsb("")).toBe("");
  });
});

describe("parseClubPaymentDetails", () => {
  const stored = JSON.stringify({
    account_name: "UTS Jitsu Club Inc",
    bsb: "062000",
    account_number: "12345678",
    bank_name: "Commonwealth Bank of Australia",
  });

  it("reads back a stored account", () => {
    expect(parseClubPaymentDetails(stored)?.account_name).toBe("UTS Jitsu Club Inc");
  });

  // Everything that is not a complete account is the same answer: not
  // published. Guessing at a partial blob would put a wrong account number in
  // front of somebody about to transfer money.
  it("returns null for anything that is not a complete account", () => {
    expect(parseClubPaymentDetails(null)).toBeNull();
    expect(parseClubPaymentDetails("")).toBeNull();
    expect(parseClubPaymentDetails("   ")).toBeNull();
    expect(parseClubPaymentDetails("not json at all")).toBeNull();
    expect(parseClubPaymentDetails("[]")).toBeNull();
    // The free text this replaced, left in the wrong key.
    expect(parseClubPaymentDetails("**BSB** 062-000")).toBeNull();
    expect(parseClubPaymentDetails(JSON.stringify({ account_name: "UTS Jitsu" }))).toBeNull();
  });
});

describe("clubPaymentFieldValue / hasInternationalDetails", () => {
  const details = clubPaymentDetailsSchema.parse({
    account_name: "UTS Jitsu Club Inc",
    bsb: "062000",
    account_number: "12345678",
    bank_name: "Commonwealth Bank of Australia",
  });

  // The one field where what is shown differs from what is stored. It has to
  // differ in exactly one place, or the hyphen ends up on screen but not on the
  // clipboard.
  it("hyphenates the BSB and passes every other field through untouched", () => {
    expect(clubPaymentFieldValue(details, "bsb")).toBe("062-000");
    expect(clubPaymentFieldValue(details, "account_number")).toBe("12345678");
    expect(clubPaymentFieldValue(details, "account_name")).toBe("UTS Jitsu Club Inc");
  });

  it("knows when there is nothing to show an overseas payer", () => {
    expect(hasInternationalDetails(details)).toBe(false);
    expect(hasInternationalDetails({ ...details, swift_bic: "CTBAAU2S" })).toBe(true);
    expect(hasInternationalDetails({ ...details, bank_address: "Sydney NSW" })).toBe(true);
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

describe("planShapeError", () => {
  const shape = (over: Record<string, unknown> = {}) => ({
    kind: "period",
    starts_on: "2026-02-02",
    ends_on: "2026-06-12",
    duration_days: null,
    session_credits: null,
    ...over,
  });

  it("accepts each kind in its intended shape", () => {
    expect(planShapeError(shape())).toBeNull();
    expect(
      planShapeError(
        shape({ kind: "insurance", starts_on: null, ends_on: null, duration_days: 365 }),
      ),
    ).toBeNull();
    expect(
      planShapeError(
        shape({ kind: "session", starts_on: null, ends_on: null, session_credits: 1 }),
      ),
    ).toBeNull();
    expect(
      planShapeError(shape({ kind: "trial", starts_on: null, ends_on: null, session_credits: 2 })),
    ).toBeNull();
  });

  // Each of these activates to `ends_at: null` while still passing
  // `sellablePlans`, i.e. a membership that never expires. For the two credit
  // kinds it is worse: `resolveCoverage` matches no tier, so it also covers
  // no class. This is the shape the deleted generic `semester` plan had.
  it("rejects a training period with no dates", () => {
    expect(planShapeError(shape({ starts_on: null, ends_on: null }))).toMatch(/start and an end/i);
    expect(planShapeError(shape({ ends_on: null }))).toMatch(/start and an end/i);
  });

  it("rejects insurance with no day count", () => {
    expect(planShapeError(shape({ kind: "insurance", starts_on: null, ends_on: null }))).toMatch(
      /how many days/i,
    );
  });

  it("rejects a credit-run plan with no credits, which would cover no class", () => {
    for (const kind of ["session", "trial"]) {
      expect(
        planShapeError(shape({ kind, starts_on: null, ends_on: null, session_credits: null })),
      ).toMatch(/never run out/i);
    }
  });

  it("rejects an end date before the start date", () => {
    expect(planShapeError(shape({ ends_on: "2026-01-01" }))).toMatch(/on or after/i);
  });

  it("treats a single-day period as valid", () => {
    expect(planShapeError(shape({ starts_on: "2026-02-02", ends_on: "2026-02-02" }))).toBeNull();
  });
});

describe("planShapeUnchanged", () => {
  const a = {
    kind: "period",
    starts_on: "2026-02-02",
    ends_on: "2026-06-12",
    duration_days: null,
    session_credits: null,
  };

  it("is true for an identical shape, so an unrelated edit stays saveable", () => {
    expect(planShapeUnchanged({ ...a }, { ...a })).toBe(true);
  });

  it.each(["kind", "starts_on", "ends_on", "duration_days", "session_credits"])(
    "is false when %s differs",
    (field) => {
      expect(planShapeUnchanged({ ...a, [field]: "changed" }, a)).toBe(false);
    },
  );
});

describe("planTypePatch", () => {
  it("gives insurance a 365-day default and drops any dates", () => {
    expect(planTypePatch("insurance")).toEqual({
      kind: "insurance",
      starts_on: null,
      ends_on: null,
      duration_days: 365,
      session_credits: null,
    });
  });

  it("clears the duration fields when switching to a dated or credit kind", () => {
    expect(planTypePatch("period")).toEqual({
      kind: "period",
      starts_on: null,
      ends_on: null,
      duration_days: null,
    });
    expect(planTypePatch("session")).toEqual({
      kind: "session",
      starts_on: null,
      ends_on: null,
      duration_days: null,
    });
  });
});

describe("strandedPlanFields", () => {
  it("finds values a kind never reads, including credits on insurance", () => {
    expect(
      strandedPlanFields({
        kind: "insurance",
        starts_on: "2026-02-02",
        ends_on: "2026-06-12",
        duration_days: 365,
        session_credits: 5,
      }),
    ).toEqual(["start and end dates", "session credits"]);
  });

  it("finds a rolling duration left on a training period", () => {
    expect(
      strandedPlanFields({
        kind: "period",
        starts_on: "2026-02-02",
        ends_on: "2026-06-12",
        duration_days: 90,
        session_credits: null,
      }),
    ).toEqual(["days from payment"]);
  });

  it("is empty for a well-formed plan of each kind", () => {
    expect(
      strandedPlanFields({
        kind: "period",
        starts_on: "2026-02-02",
        ends_on: "2026-06-12",
        duration_days: null,
        session_credits: null,
      }),
    ).toEqual([]);
    expect(
      strandedPlanFields({
        kind: "trial",
        starts_on: null,
        ends_on: null,
        duration_days: null,
        session_credits: 2,
      }),
    ).toEqual([]);
  });
});
