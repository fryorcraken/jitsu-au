import { describe, expect, it } from "vitest";
import {
  AGENT_MANIFEST,
  projectAgentCodeOfConductVersion,
  AgentError,
  bearerToken,
  buildInvoicePatch,
  classifyAction,
  diffInvoicePatch,
  INVOICE_EDITABLE_FIELDS,
  invoiceEditAudit,
  projectAgentKbArticle,
  projectAgentWaiverTemplate,
  projectInvoice,
  RECONCILED_GUARDED_FIELDS,
  reconciledEditBlockers,
  reconciledEditMessage,
  safeEqual,
  mergeAgentBlogPostEdit,
  projectAgentBlogPost,
  projectAgentCalendarEvent,
} from "./manager-agent";
import {
  createInvoiceSchema,
  deleteInvoiceSchema,
  editInvoiceSchema,
  markInvoicePaidSchema,
  managerAgentActions,
  paperWaiverUploadSchema,
} from "./validation";
import type { EditInvoiceInput } from "./validation";
import type { MembershipPlanRow, MembershipRow } from "./membership-types";

describe("safeEqual", () => {
  it("is true for equal strings", () => {
    expect(safeEqual("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("is false for different strings of equal length", () => {
    expect(safeEqual("aaaaaa", "aaaaab")).toBe(false);
  });

  it("is false for different lengths and non-strings", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    // @ts-expect-error guarding runtime misuse
    expect(safeEqual(undefined, "x")).toBe(false);
  });
});

describe("bearerToken", () => {
  it("extracts the token, case-insensitive on the scheme", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer   abc123  ")).toBe("abc123");
  });

  it("returns null when missing or malformed", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("abc123")).toBeNull();
  });
});

describe("editInvoiceSchema", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  it("accepts a single editable field", () => {
    const parsed = editInvoiceSchema.parse({ id, price_cents: 4500 });
    expect(parsed.price_cents).toBe(4500);
  });

  it("rejects when no editable field is provided", () => {
    expect(() => editInvoiceSchema.parse({ id })).toThrow(/at least one/i);
  });

  it("rejects activating an invoice via a raw edit", () => {
    expect(() => editInvoiceSchema.parse({ id, status: "active" })).toThrow();
    // the safe transitions still parse
    expect(editInvoiceSchema.parse({ id, status: "cancelled" }).status).toBe("cancelled");
  });

  it("rejects a non-uuid id and a negative price", () => {
    expect(() => editInvoiceSchema.parse({ id: "nope", notes: "x" })).toThrow();
    expect(() => editInvoiceSchema.parse({ id, price_cents: -1 })).toThrow();
  });

  it("accepts a null notes to clear it, distinct from omitting the field", () => {
    expect(editInvoiceSchema.parse({ id, notes: null }).notes).toBeNull();
    expect(editInvoiceSchema.parse({ id, price_cents: 100 }).notes).toBeUndefined();
  });

  it("names an unrecognized field instead of reporting no fields at all", () => {
    const result = editInvoiceSchema.safeParse({ id, price: 999 });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0].message).toMatch(/price/);
  });

  it("takes confirm_paid_edit without treating it as a field to write", () => {
    expect(
      editInvoiceSchema.parse({ id, price_cents: 100, confirm_paid_edit: true }),
    ).toMatchObject({ confirm_paid_edit: true });
    // On its own it edits nothing, so it must not satisfy the at-least-one rule.
    expect(() => editInvoiceSchema.parse({ id, confirm_paid_edit: true })).toThrow(/at least one/i);
    // And it is never written to the row.
    expect(
      buildInvoicePatch(editInvoiceSchema.parse({ id, notes: "x", confirm_paid_edit: true })),
    ).toEqual({ notes: "x" });
  });
});

describe("deleteInvoiceSchema", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  it("takes an id and nothing else", () => {
    expect(deleteInvoiceSchema.parse({ id }).id).toBe(id);
  });

  // There is deliberately no confirm flag: the delete blockers are not a
  // caller's judgement call, so an agent reaching for one has misunderstood and
  // should hear about it rather than have the key silently ignored.
  it("refuses a confirm flag rather than dropping it", () => {
    expect(() => deleteInvoiceSchema.parse({ id, confirm_paid_edit: true })).toThrow();
    expect(() => deleteInvoiceSchema.parse({ id, force: true })).toThrow();
  });
});

describe("createInvoiceSchema", () => {
  const base = { user_id: "11111111-1111-1111-1111-111111111111", plan_code: "2026-s2" };

  it("raises an invoice for a named person against a named plan", () => {
    const parsed = createInvoiceSchema.parse(base);
    expect(parsed.user_id).toBe(base.user_id);
    expect(parsed.plan_code).toBe("2026-s2");
  });

  it("emails them unless the caller says not to", () => {
    expect(createInvoiceSchema.parse(base).send_email).toBe(true);
    expect(createInvoiceSchema.parse({ ...base, send_email: false }).send_email).toBe(false);
  });

  // Same rule as edit_invoice: a typo must name itself rather than being
  // silently dropped, or a call that did half of what was asked reads as a
  // success.
  it("names an unknown param instead of ignoring it", () => {
    expect(() => createInvoiceSchema.parse({ ...base, price_cents: 1000 })).toThrow(/price_cents/);
  });

  // Recording a payment emails a receipt and makes the row permanent. Raising
  // an invoice is not allowed to do that as a side effect.
  it("has no way to claim the invoice was paid", () => {
    expect(() => createInvoiceSchema.parse({ ...base, status: "active" })).toThrow();
    expect(() => createInvoiceSchema.parse({ ...base, paid_at: "2026-08-01" })).toThrow();
  });
});

describe("markInvoicePaidSchema", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  // A caller reaching for this action is recording something the bank reconciler
  // could not see. Defaulting to bank_transfer would put a claim in the club's
  // books that no statement will ever back up.
  it("assumes a manual payment unless told otherwise", () => {
    expect(markInvoicePaidSchema.parse({ id }).payment_method).toBe("manual");
  });

  it("takes a named method", () => {
    expect(markInvoicePaidSchema.parse({ id, payment_method: "stripe" }).payment_method).toBe(
      "stripe",
    );
  });

  it("refuses a method the memberships table would not accept", () => {
    expect(() => markInvoicePaidSchema.parse({ id, payment_method: "cash" })).toThrow();
  });

  // The day goes in as `paid_on`, a date. A caller reaching for the column name
  // `paid_at` must hear that it was not used, not have its date silently dropped
  // and today's recorded in its place.
  it("names an unknown param rather than dropping it", () => {
    expect(() => markInvoicePaidSchema.parse({ id, paid_at: "2026-08-01" })).toThrow(/paid_at/);
  });

  it("takes the day the money arrived and what it was known by", () => {
    expect(
      markInvoicePaidSchema.parse({ id, paid_on: "2026-08-01", paid_reference: "Receipt 42" }),
    ).toMatchObject({ paid_on: "2026-08-01", paid_reference: "Receipt 42" });
  });
});

describe("classifyAction", () => {
  const valid = ["list_users", "edit_invoice"];

  it("distinguishes a missing action from an invalid one", () => {
    expect(classifyAction(undefined, valid)).toEqual({
      ok: false,
      code: "missing_action",
      message: "Missing required field: action.",
    });
    expect(classifyAction("nope", valid).ok).toBe(false);
    expect((classifyAction("nope", valid) as { code: string }).code).toBe("unknown_action");
  });

  it("treats an explicit null action as missing, not unknown", () => {
    expect(classifyAction(null, valid)).toEqual({
      ok: false,
      code: "missing_action",
      message: "Missing required field: action.",
    });
  });

  it("accepts a valid action", () => {
    expect(classifyAction("edit_invoice", valid)).toEqual({ ok: true, action: "edit_invoice" });
  });
});

describe("buildInvoicePatch", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  it("includes only the fields that were supplied", () => {
    const patch = buildInvoicePatch({ id, notes: "called member", status: "cancelled" });
    expect(patch).toEqual({ notes: "called member", status: "cancelled" });
    expect("price_cents" in patch).toBe(false);
  });

  it("writes an explicit null notes as a clear, distinct from an omitted field", () => {
    const patch = buildInvoicePatch({ id, notes: null });
    expect(patch).toEqual({ notes: null });
    const untouched = buildInvoicePatch({ id, price_cents: 100 });
    expect("notes" in untouched).toBe(false);
  });

  // A start date is named as a DAY and placed by the plan. The caller never
  // hands over instants, so the two columns cannot be pulled apart into a
  // window no plan sells.
  it("writes the resolved window, and never takes starts_at/ends_at from input", () => {
    const patch = buildInvoicePatch({ id, starts_on: "2026-02-01" });
    expect(patch).toEqual({});
    const withWindow = buildInvoicePatch(
      { id, starts_on: "2026-02-01" },
      { starts_at: "2026-01-31T13:00:00.000Z", ends_at: "2027-01-31T13:00:00.000Z" },
    );
    expect(withWindow).toEqual({
      starts_at: "2026-01-31T13:00:00.000Z",
      ends_at: "2027-01-31T13:00:00.000Z",
    });
    expect("starts_on" in withWindow).toBe(false);
  });

  it("only ever writes whitelisted columns", () => {
    const patch = buildInvoicePatch({
      id,
      price_cents: 100,
      notes: "n",
      payment_reference: "MEMX",
      payment_method: "manual",
      status: "pending",
    });
    for (const key of Object.keys(patch)) {
      expect(INVOICE_EDITABLE_FIELDS).toContain(key);
    }
  });
});

describe("diffInvoicePatch", () => {
  it("reports only the fields whose value actually moves", () => {
    const existing = { price_cents: 0, notes: null, status: "active" };
    const diff = diffInvoicePatch(existing, { price_cents: 24500, status: "active" });
    // status was submitted with the value it already held: not an edit.
    expect(diff.changed).toEqual(["price_cents"]);
    expect(diff.previous).toEqual({ price_cents: 0 });
  });

  it("is empty for an edit that changes nothing", () => {
    const existing = { notes: "called member", price_cents: 100 };
    expect(diffInvoicePatch(existing, { notes: "called member" })).toEqual({
      changed: [],
      previous: {},
    });
  });

  it("counts clearing a note as a change and remembers what it held", () => {
    const diff = diffInvoicePatch({ notes: "typo" }, { notes: null });
    expect(diff.changed).toEqual(["notes"]);
    expect(diff.previous).toEqual({ notes: "typo" });
    // A null note cleared again is still a no-op.
    expect(diffInvoicePatch({ notes: null }, { notes: null }).changed).toEqual([]);
  });
});

describe("reconciledEditBlockers", () => {
  const paid = { paid_at: "2026-07-28T11:06:27.181+00:00" };
  const unpaid = { paid_at: null };

  it("blocks the money fields on an invoice that has been paid", () => {
    expect(reconciledEditBlockers(paid, ["price_cents"], undefined)).toEqual(["price_cents"]);
    expect(reconciledEditBlockers(paid, ["payment_reference"], undefined)).toEqual([
      "payment_reference",
    ]);
    expect(reconciledEditBlockers(paid, ["payment_method"], undefined)).toEqual(["payment_method"]);
  });

  it("leaves notes and status alone: neither is a claim about money that moved", () => {
    expect(reconciledEditBlockers(paid, ["notes", "status"], undefined)).toEqual([]);
    // Expiring a membership that ran its course is an ordinary lifecycle move,
    // and the one status with consequences ("active") is refused by the schema.
    expect(RECONCILED_GUARDED_FIELDS).not.toContain("status");
    expect(RECONCILED_GUARDED_FIELDS).not.toContain("notes");
  });

  // The correction is wanted most often BECAUSE the money already landed: a
  // year of cover settled in March and recorded in April. Guarding the dates
  // would refuse the edit they exist for.
  it("leaves the cover dates alone on a paid invoice: they are not a money record", () => {
    expect(reconciledEditBlockers(paid, ["starts_at", "ends_at"], undefined)).toEqual([]);
    expect(RECONCILED_GUARDED_FIELDS).not.toContain("starts_at");
    expect(RECONCILED_GUARDED_FIELDS).not.toContain("ends_at");
  });

  it("does not block anything on an unpaid invoice, or when the caller confirms", () => {
    expect(reconciledEditBlockers(unpaid, ["price_cents"], undefined)).toEqual([]);
    expect(reconciledEditBlockers(paid, ["price_cents"], true)).toEqual([]);
  });

  it("names the fields and the way past it in the message", () => {
    const msg = reconciledEditMessage(["price_cents"], "2026-07-28T11:06:27.181+00:00");
    expect(msg).toMatch(/price_cents/);
    expect(msg).toMatch(/confirm_paid_edit/);
  });

  // The guard keys off paid_at, so it only holds while paid_at is unreachable
  // through this endpoint. If it ever became editable, a caller could null it,
  // rewrite the price unguarded, and set it back — laundering the money record
  // through exactly the API this guard protects. Pinned rather than assumed.
  it("cannot be laundered: paid_at is not editable, so the guard cannot be switched off", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(editInvoiceSchema.safeParse({ id, paid_at: null }).success).toBe(false);
    expect(editInvoiceSchema.safeParse({ id, paid_at: "2026-01-01T00:00:00Z" }).success).toBe(
      false,
    );
    expect(INVOICE_EDITABLE_FIELDS).not.toContain("paid_at");
    // And the patch builder would drop it even if a schema change let it in.
    expect(
      buildInvoicePatch({ price_cents: 1, paid_at: null } as Partial<EditInvoiceInput>),
    ).toEqual({ price_cents: 1 });
  });
});

describe("invoiceEditAudit", () => {
  it("records who changed what, from what, to what", () => {
    const entry = invoiceEditAudit({
      invoiceId: "inv-1",
      actor: "manager-1",
      paidAt: "2026-07-28T11:06:27.181+00:00",
      confirmed: true,
      diff: { changed: ["price_cents"], previous: { price_cents: 0 } },
      patch: { price_cents: 24500 },
      at: "2026-07-31T00:00:00.000Z",
    });
    expect(entry).toEqual({
      event: "invoice_edited",
      invoice_id: "inv-1",
      actor: "manager-1",
      at: "2026-07-31T00:00:00.000Z",
      reconciled: true,
      overridden: true,
      changes: [{ field: "price_cents", from: 0, to: 24500 }],
    });
  });

  it("is not 'overridden' when there was nothing to override", () => {
    const entry = invoiceEditAudit({
      invoiceId: "inv-1",
      actor: "manager-1",
      paidAt: null,
      confirmed: true,
      diff: { changed: ["notes"], previous: { notes: null } },
      patch: { notes: "chased" },
      at: "2026-07-31T00:00:00.000Z",
    });
    expect(entry.reconciled).toBe(false);
    expect(entry.overridden).toBe(false);
  });

  // A client that sets confirm_paid_edit defensively on every call, then edits
  // only notes, has overridden nothing. Logging that as an override would put
  // false "someone rewrote the money record" entries in the one log the club
  // would use to reconstruct a books-versus-bank disagreement.
  it("is not 'overridden' when the flag was set but no guarded field moved", () => {
    const entry = invoiceEditAudit({
      invoiceId: "inv-1",
      actor: "manager-1",
      paidAt: "2026-07-28T11:06:27.181+00:00",
      confirmed: true,
      diff: { changed: ["notes"], previous: { notes: null } },
      patch: { notes: "cash on the night" },
      at: "2026-07-31T00:00:00.000Z",
    });
    // The invoice IS reconciled, but this edit did not touch the money record.
    expect(entry.reconciled).toBe(true);
    expect(entry.overridden).toBe(false);
  });
});

describe("projectInvoice", () => {
  const membership: MembershipRow = {
    id: "abc",
    user_id: "user-1",
    plan_id: "plan-1",
    status: "pending",
    is_student: false,
    uts_student_number: null,
    price_cents: 24500,
    payment_reference: "MEMNGUYEN7Q",
    payment_method: "bank_transfer",
    paid_at: null,
    paid_reference: null,
    starts_at: null,
    ends_at: null,
    sessions_remaining: null,
    session_date: null,
    notes: null,
    created_at: "2026-07-22T00:00:00Z",
  };
  const plan = {
    id: "plan-1",
    code: "semester_2_2026",
    name: "Semester 2 2026",
  } as MembershipPlanRow;

  it("formats the price and carries the plan code", () => {
    const p = projectInvoice(membership, plan);
    expect(p.price).toBe("$245");
    expect(p.plan_code).toBe("semester_2_2026");
    expect(p.id).toBe("abc");
  });

  // What a payment recorded by hand was known by, so an agent reconciling the
  // books can find the receipt behind a manual payment.
  it("carries the payment's own reference beside the one the member quotes", () => {
    const p = projectInvoice(
      { ...membership, paid_at: "2026-10-01T02:00:00Z", paid_reference: "Receipt 42" },
      plan,
    );
    expect(p.paid_reference).toBe("Receipt 42");
    expect(p.payment_reference).toBe("MEMNGUYEN7Q");
  });

  it("tolerates a missing plan", () => {
    const p = projectInvoice(membership, undefined);
    expect(p.plan_code).toBeNull();
    expect(p.plan_name).toBeNull();
    expect(p.sessions_allowed).toBeNull();
  });

  it("exposes the plan's session allowance and this invoice's own remaining balance", () => {
    const trialPlan = {
      id: "plan-2",
      code: "trial_2_session",
      name: "Free trial",
      session_credits: 2,
    } as MembershipPlanRow;
    const trialMembership = { ...membership, plan_id: "plan-2", sessions_remaining: 1 };
    const p = projectInvoice(trialMembership, trialPlan);
    expect(p.sessions_allowed).toBe(2);
    expect(p.sessions_remaining).toBe(1);
  });

  it("is null for a plan with no session credits", () => {
    const p = projectInvoice(membership, plan);
    expect(p.sessions_allowed).toBeNull();
    expect(p.sessions_remaining).toBeNull();
  });

  it("distinguishes 'no session credits' from 'not yet activated'", () => {
    // A paid session-credit plan (like casual_session) stays pending — and
    // sessions_remaining null — until bank-transfer activation sets it, unlike
    // the free trial which activates immediately. sessions_allowed must still
    // report the allowance so a caller doesn't read a still-pending invoice as
    // having no credits at all.
    const casualPlan = {
      id: "plan-3",
      code: "casual_session",
      name: "Casual class",
      session_credits: 1,
    } as MembershipPlanRow;
    const pendingCasual = { ...membership, plan_id: "plan-3", status: "pending" as const };
    const p = projectInvoice(pendingCasual, casualPlan);
    expect(p.sessions_allowed).toBe(1);
    expect(p.sessions_remaining).toBeNull();
    expect(p.status).toBe("pending");
  });
});

describe("AGENT_MANIFEST", () => {
  it("documents exactly the actions the endpoint dispatches", () => {
    const names = AGENT_MANIFEST.actions.map((a) => a.name).sort();
    expect(names).toEqual([...managerAgentActions].sort());
  });

  // Round 2 of the dev probes noted that the manifest still said "1" after the
  // behaviour changed, leaving a client no way to tell the generations apart.
  it("advertises a version a client can branch on", () => {
    expect(AGENT_MANIFEST.version).toBe("34");
  });

  // The changelog is only worth having if it cannot fall behind the version it
  // describes. Bumping one without the other is the failure this catches.
  it("documents the current version at the head of the changelog", () => {
    expect(AGENT_MANIFEST.changes[0].version).toBe(AGENT_MANIFEST.version);
    expect(AGENT_MANIFEST.changes[0].notes.length).toBeGreaterThan(0);
  });

  it("has no duplicate or empty changelog entries", () => {
    const versions = AGENT_MANIFEST.changes.map((c) => c.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const entry of AGENT_MANIFEST.changes) {
      expect(entry.notes.every((n) => n.trim().length > 0)).toBe(true);
    }
  });

  it("tells a caching client which calls could newly start failing", () => {
    // The two refusals introduced in "2" are the notes that matter most to a
    // client holding a cached "1": they turn calls that used to succeed into
    // errors. If either stops being announced, a batch job finds out the hard way.
    const notes = AGENT_MANIFEST.changes.find((c) => c.version === "2")!.notes.join(" ");
    expect(notes).toMatch(/reconciled_invoice/);
    expect(notes).toMatch(/duplicate_waiver/);
  });

  it("announces the insurance reminder state the listings now carry", () => {
    const entry = AGENT_MANIFEST.changes.find((c) => c.version === "27")!;
    expect(entry.breaking).toBe(false);
    const notes = entry.notes.join(" ");
    expect(notes).toMatch(/insurance_reminder/);
    expect(notes).toMatch(/ends_within_14_days/);
    expect(notes).toMatch(/last_sent/);
    for (const name of ["list_invoices", "list_users", "get_user"]) {
      const spec = AGENT_MANIFEST.actions.find((a) => a.name === name)!;
      expect(spec.summary).toMatch(/insurance_reminder/);
    }
  });

  it("announces the site banner actions", () => {
    const entry = AGENT_MANIFEST.changes.find((c) => c.version === "29")!;
    expect(entry.breaking).toBe(false);
    const notes = entry.notes.join(" ");
    expect(notes).toMatch(/get_site_banner/);
    expect(notes).toMatch(/save_site_banner/);
    // The merge is the thing a caller would otherwise get wrong: turning the
    // banner off must not look like it needs the message sent again.
    expect(notes).toMatch(/keeps its stored value/);
  });

  it("announces the blog post kind", () => {
    const entry = AGENT_MANIFEST.changes.find((c) => c.version === "34")!;
    expect(entry.breaking).toBe(false);
    const notes = entry.notes.join(" ");
    for (const action of ["list_blog_posts", "get_blog_post", "save_blog_post"]) {
      expect(notes).toContain(action);
    }
    // What a caller relying on a cached manifest has to know to not demote an
    // article by leaving the field out.
    expect(notes).toMatch(/omits it keeps the stored one/);
  });

  it("documents kind on save_blog_post", () => {
    const save = AGENT_MANIFEST.actions.find((a) => a.name === "save_blog_post")!;
    const kind = save.params.find((p) => p.name === "kind");
    expect(kind?.required).toBe(false);
    expect(kind?.description).toMatch(/^article \| update\./);
  });

  it("announces the calendar actions", () => {
    const entry = AGENT_MANIFEST.changes.find((c) => c.version === "32")!;
    expect(entry.breaking).toBe(false);
    const notes = entry.notes.join(" ");
    for (const action of [
      "list_calendar_events",
      "list_calendar_rsvps",
      "create_calendar_entry",
      "edit_calendar_entry",
      "cancel_calendar_entry",
      "stop_calendar_repeat",
      "delete_calendar_entry",
    ]) {
      expect(notes).toContain(action);
    }
    // The refusal that makes a create safe to resend, which a caller holding a
    // cached manifest has to know about to rely on it.
    expect(notes).toMatch(/already_on_calendar/);
    // And the one that turns a weekly entry with no dates to come from a quiet
    // "added" into an error.
    expect(notes).toMatch(/no_dates/);
  });

  // Dates are topped up once the furthest is within six weeks, so anything
  // past six weeks out may not be listed yet. Promising twelve would send an
  // agent to add a one-off for a week it thinks is missing.
  it("tells an agent how far ahead the calendar list can be relied on", () => {
    const spec = AGENT_MANIFEST.actions.find((a) => a.name === "list_calendar_events")!;
    expect(spec.summary).toMatch(/six weeks/);
    expect(spec.summary).not.toMatch(/about twelve weeks/);
    expect(spec.params).toEqual([]);
  });

  it("announces the name parts get_user's profile now carries", () => {
    const entry = AGENT_MANIFEST.changes.find((c) => c.version === "28")!;
    expect(entry.breaking).toBe(false);
    const notes = entry.notes.join(" ");
    for (const field of ["first_name", "middle_name", "last_name"]) expect(notes).toMatch(field);
    const spec = AGENT_MANIFEST.actions.find((a) => a.name === "get_user")!;
    expect(spec.summary).toMatch(/first, middle, last and preferred name/);
  });

  it("announces file_waiver's address in parts, and that a single line still works", () => {
    const entry = AGENT_MANIFEST.changes.find((c) => c.version === "30")!;
    expect(entry.breaking).toBe(false);
    const notes = entry.notes.join(" ");
    expect(notes).toMatch(/address_parts/);
    expect(notes).toMatch(/guardian_address_parts/);
    expect(notes).toMatch(/still accepted/);
    const params = AGENT_MANIFEST.actions
      .find((a) => a.name === "file_waiver")!
      .params.map((p) => [p.name, p.required]);
    expect(params).toEqual(
      expect.arrayContaining([
        ["address_parts", false],
        ["address", false],
        ["guardian_address_parts", false],
      ]),
    );
  });

  // #112 shipped a field whose MEANING changed with no manifest bump, no note
  // and no doc, and the review caught it rather than a test. This is that test:
  // a response field an agent is told to read has to be announced, or a client
  // holding a cached manifest never learns it exists.
  it("announces the household fields list_users now carries", () => {
    const notes = AGENT_MANIFEST.changes.find((c) => c.version === "17")!.notes.join(" ");
    expect(notes).toMatch(/guardian_user_id/);
    expect(notes).toMatch(/dependants/);
    // The note that matters most to a caching client, and the one #112's
    // failure was: an EXISTING field whose meaning moved. `lifecycle_status`
    // now reaches through the household, which also changes which rows a
    // `status` filter returns.
    expect(notes).toMatch(/lifecycle_status/);
    expect(notes).toMatch(/roles/);
    // The trap worth naming, because a caller that falls into it reports a
    // parent as having no children rather than failing.
    expect(notes).toMatch(/status/);
  });

  // Fields a caching client is told to read have to be announced, the lesson of
  // #112 pinned above. These are the ones "23" added.
  it("announces get_user and the headline fields list_users now carries", () => {
    const notes = AGENT_MANIFEST.changes.find((c) => c.version === "23")!.notes.join(" ");
    expect(notes).toMatch(/get_user/);
    expect(notes).toMatch(/phone/);
    expect(notes).toMatch(/email_confirmed_at/);
    expect(notes).toMatch(/code_of_conduct/);
    // What it deliberately does not report, so nobody goes looking for it.
    expect(notes).toMatch(/signer_ip/);
    const getUser = AGENT_MANIFEST.actions.find((a) => a.name === "get_user")!;
    expect(getUser.params.map((p) => [p.name, p.required])).toEqual([["user_id", true]]);
  });

  it("announces the code of conduct actions, and the change in what outdated means", () => {
    const notes = AGENT_MANIFEST.changes.find((c) => c.version === "24")!.notes.join(" ");
    for (const action of [
      "list_code_of_conduct_versions",
      "get_code_of_conduct",
      "save_code_of_conduct",
      "publish_code_of_conduct",
    ]) {
      expect(notes).toContain(action);
    }
    expect(notes).toMatch(/asks_reagreement/);
    // The note a caller acting on `state` needs: an existing field moved.
    expect(notes).toMatch(/required_version/);
    const save = AGENT_MANIFEST.actions.find((a) => a.name === "save_code_of_conduct")!;
    expect(save.params.map((p) => p.name)).toEqual([
      "title",
      "body_md",
      "asks_reagreement",
      "base_version",
      "client_submission_id",
    ]);
    expect(save.params.every((p) => !p.required)).toBe(true);
  });

  // Announcing a plan emails the whole club, so the manifest has to tell a
  // client both halves: that the params exist, and that a retry must carry the
  // same id or it emails everyone twice.
  it("announces save_membership_plan's announce params and how to retry them", () => {
    const save = AGENT_MANIFEST.actions.find((a) => a.name === "save_membership_plan")!;
    expect(save.params.map((p) => p.name)).toEqual(
      expect.arrayContaining(["announce", "announcement_id"]),
    );
    const notes = AGENT_MANIFEST.changes.find((c) => c.version === "26")!.notes.join(" ");
    expect(notes).toMatch(/announce: true/);
    expect(notes).toMatch(/same announcement_id/);
    expect(notes).toMatch(/announcement_failed/);
    expect(notes).toMatch(/last_announcement/);
  });

  it("documents the confirmation flags the schemas actually accept", () => {
    const edit = AGENT_MANIFEST.actions.find((a) => a.name === "edit_invoice")!;
    expect(edit.params.map((p) => p.name)).toContain("confirm_paid_edit");
    const file = AGENT_MANIFEST.actions.find((a) => a.name === "file_waiver")!;
    expect(file.params.map((p) => p.name)).toContain("confirm_duplicate");
    const id = "11111111-1111-1111-1111-111111111111";
    expect(editInvoiceSchema.safeParse({ id, notes: "x", confirm_paid_edit: true }).success).toBe(
      true,
    );
  });

  it("marks the invoice id as the only required edit param", () => {
    const edit = AGENT_MANIFEST.actions.find((a) => a.name === "edit_invoice")!;
    const required = edit.params.filter((p) => p.required).map((p) => p.name);
    expect(required).toEqual(["id"]);
  });

  // `email` deliberately keeps `required: true` even though a dependant filing
  // refuses it. It IS required for the default signing_for, which is what every
  // caller sends, and the exception lives in its description, exactly as
  // `emergency_contact_relationship` handles being required only for a minor.
  // What must not happen is the manifest going quiet about the new shape.
  it("documents the dependant filing an agent can now send", () => {
    const fileWaiver = AGENT_MANIFEST.actions.find((a) => a.name === "file_waiver")!;
    const params = new Map(fileWaiver.params.map((p) => [p.name, p]));

    const signingFor = params.get("signing_for");
    expect(signingFor).toBeDefined();
    expect(signingFor!.required).toBe(false);
    expect(signingFor!.description).toMatch(/dependant/i);
    // The two params whose meaning changes have to say so, or an agent reading
    // the manifest sends a call the endpoint refuses.
    expect(params.get("email")!.description).toMatch(/dependant/i);
    expect(params.get("guardian_email")!.description).toMatch(/required/i);
    expect(params.get("guardian_name")!.description).toMatch(/required/i);

    // ...and the shape it describes is the shape the schema takes.
    const dependant = {
      first_name: "Ada",
      last_name: "Lovelace",
      date_of_birth: "2016-03-02",
      address: "1 Broadway",
      phone: "0400000000",
      signing_for: "dependant" as const,
      guardian_email: "parent@example.com",
      guardian_name: "Charles Babbage",
      // Required because this child was under 18 on the signing date, which is
      // an existing rule, unchanged.
      guardian_relationship: "Father",
      emergency_contact_name: "Charles",
      emergency_contact_phone: "0400000001",
      signed_on: "2026-01-15",
      scan: [{ name: "w.pdf", type: "application/pdf" as const, data: "aGk=" }],
    };
    expect(paperWaiverUploadSchema.safeParse(dependant).success).toBe(true);
    // And the address it refuses is refused.
    expect(
      paperWaiverUploadSchema.safeParse({ ...dependant, email: "child@example.com" }).success,
    ).toBe(false);
  });

  it("documents file_waiver's required params in step with the schema", () => {
    const file = AGENT_MANIFEST.actions.find((a) => a.name === "file_waiver")!;
    const documented = new Set(file.params.filter((p) => p.required).map((p) => p.name));
    // The manifest is prose an agent reads before acting; if it stops matching
    // what the Zod schema actually enforces, the endpoint would reject a call
    // the manifest said was fine. emergency_contact_relationship is left off
    // this list on purpose: required only for a minor, and the manifest says
    // so in its description rather than as an unconditional required flag.
    // The address is the same: one of address_parts or address is required,
    // which neither param can say as a flag (checked separately below).
    const schemaRequired = new Set([
      "first_name",
      "last_name",
      "date_of_birth",
      "phone",
      "email",
      "emergency_contact_name",
      "emergency_contact_phone",
      "signed_on",
      "scan",
    ]);
    expect(documented).toEqual(schemaRequired);
    for (const name of schemaRequired) {
      expect(
        paperWaiverUploadSchema.safeParse({
          first_name: "Ada",
          last_name: "Lovelace",
          date_of_birth: "1990-01-01",
          address: "1 Broadway",
          phone: "0400000000",
          email: "ada@example.com",
          emergency_contact_name: "Charles",
          emergency_contact_phone: "0400000001",
          signed_on: "2020-01-01",
          scan: [{ name: "w.pdf", type: "application/pdf", data: "aGlw" }],
          [name]: undefined,
        }).success,
        name,
      ).toBe(false);
    }
    // Neither address param on its own is required, but one of them is.
    expect(
      paperWaiverUploadSchema.safeParse({
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1990-01-01",
        phone: "0400000000",
        email: "ada@example.com",
        emergency_contact_name: "Charles",
        emergency_contact_phone: "0400000001",
        signed_on: "2020-01-01",
        scan: [{ name: "w.pdf", type: "application/pdf", data: "aGlw" }],
      }).success,
    ).toBe(false);
  });
});

describe("AgentError", () => {
  it("carries an http status and a machine code", () => {
    const e = new AgentError(401, "unauthorized", "nope");
    expect(e.httpStatus).toBe(401);
    expect(e.code).toBe("unauthorized");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("projectAgentKbArticle", () => {
  const article = {
    slug: "our-history",
    nav_title: null as string | null,
    link_path: null as string | null,
    section_id: "sec-1",
    position: 20,
    visibility: "members",
    annotations_enabled: true,
    updated_at: "2026-07-01T00:00:00Z",
  };
  const live = {
    title: "Our history, 2004 to today",
    version: 3,
    created_at: "2026-07-20T00:00:00Z",
    change_note: "Added the founding years",
  };

  it("reports the live version's heading, not the sidebar label", () => {
    // The bug this pins: falling back to `nav_title` first made an article's
    // real heading unobtainable from the list, so an agent that built a
    // save_kb_article from what it read renamed the heading to the nav label.
    const row = projectAgentKbArticle({ ...article, nav_title: "Our history" }, live, "about", 3);
    expect(row.title).toBe("Our history, 2004 to today");
    expect(row.nav_title).toBe("Our history");
  });

  it("falls back to nothing rather than the label when there is no live version", () => {
    expect(projectAgentKbArticle(article, undefined, "about", 0).title).toBeNull();
  });

  // A link entry has no version, so its label IS its title, and the null
  // version is what tells an agent it cannot be given text.
  it("names a link entry by its label and points its url at the destination", () => {
    const row = projectAgentKbArticle(
      { ...article, slug: "common-questions", nav_title: "Common questions", link_path: "/faq" },
      undefined,
      "start-here",
      0,
    );
    expect(row).toMatchObject({
      title: "Common questions",
      link_path: "/faq",
      version: null,
      url: "/faq",
    });
  });

  it("gives an article a /kb url and reports where it sits", () => {
    const row = projectAgentKbArticle(article, live, "about-the-club", 3);
    expect(row).toMatchObject({
      url: "/kb/our-history",
      section: "about-the-club",
      position: 20,
      version: 3,
      versions: 3,
      updated_at: "2026-07-20T00:00:00Z",
    });
  });

  // An article the club has not filed has no section, and the list must say so
  // rather than inventing one.
  it("reports a null section for an unfiled article", () => {
    expect(
      projectAgentKbArticle({ ...article, section_id: null }, live, null, 1).section,
    ).toBeNull();
  });
});

describe("projectAgentWaiverTemplate", () => {
  const version = {
    version: 4,
    title: "Training Waiver",
    body_md: "# Waiver\n\nSigned by {{full_name}}.",
    acknowledgements: [
      { id: "media", label: "I consent to being photographed.", required: false },
      { id: "risk", label: "I accept the risks.", required: true },
    ],
    is_current: true,
    created_at: "2026-08-01T00:00:00Z",
  };

  // The list is what a caller reads before deciding what to edit, and a club
  // with a dozen versions of a 30000-character legal document would otherwise
  // be sending a third of a megabyte to answer "which one is live".
  it("leaves the body out but says how long it is", () => {
    const row = projectAgentWaiverTemplate(version, 4);
    expect(row).not.toHaveProperty("body_md");
    expect(row.body_chars).toBe(version.body_md.length);
    expect(row.acknowledgement_count).toBe(2);
    // Not `acknowledgements`: that name holds the real list on
    // get_waiver_template, and a caller iterating a 2 is the bug this prevents.
    expect(row).not.toHaveProperty("acknowledgements");
  });

  // Same word the manager reads off the editor screen for the same row: an
  // agent reporting "draft" for what the screen calls "previous" would have a
  // manager approve a rollback to wording they think was never published.
  it("labels a version the way the editor screen labels it", () => {
    expect(projectAgentWaiverTemplate(version, 4).status).toBe("Live");
    expect(
      projectAgentWaiverTemplate({ ...version, version: 2, is_current: false }, 4).status,
    ).toBe("Previous");
    expect(
      projectAgentWaiverTemplate({ ...version, version: 7, is_current: false }, 4).status,
    ).toBe("Draft");
  });

  it("carries the version number and the live flag a caller branches on", () => {
    expect(projectAgentWaiverTemplate({ ...version, is_current: false }, 9)).toMatchObject({
      version: 4,
      is_current: false,
      title: "Training Waiver",
      created_at: "2026-08-01T00:00:00Z",
    });
  });
});

describe("projectAgentCodeOfConductVersion", () => {
  const version = {
    version: 5,
    title: "UTS Jitsu Code of Conduct",
    asks_reagreement: true,
    required_version: 5,
    is_current: false,
    first_published_at: "2026-10-02T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
  };

  it("reports a version without its text, with the editor's own label", () => {
    expect(projectAgentCodeOfConductVersion({ ...version, version: 3 }, 4)).toEqual({
      version: 3,
      title: "UTS Jitsu Code of Conduct",
      is_current: false,
      status: "Previous",
      asks_reagreement: true,
      required_version: 5,
      first_published_at: "2026-10-02T00:00:00.000Z",
      created_at: "2026-10-01T00:00:00.000Z",
    });
  });

  // Rolled back from 5 to 4: version 5 was live, and people agreed to it.
  it("calls a version rolled away from Previous, not Draft", () => {
    expect(projectAgentCodeOfConductVersion(version, 4).status).toBe("Previous");
  });

  it("calls a version that never went live a Draft", () => {
    expect(
      projectAgentCodeOfConductVersion({ ...version, first_published_at: null }, 4).status,
    ).toBe("Draft");
  });
});

describe("mergeAgentBlogPostEdit", () => {
  const stored = {
    id: "5b0f3c1e-9a8d-4c2b-8e7f-1a2b3c4d5e6f",
    slug: "2026-09-01-welcome",
    title: "Welcome",
    excerpt: "Hello.",
    body_md: "Hello, and welcome.",
    cover_image_path: "drafts/cover.jpg",
    status: "published",
    kind: "update",
    seo_title: "Welcome to the club",
    seo_description: "What to expect at your first class.",
  };

  it("keeps every field the agent left out", () => {
    expect(mergeAgentBlogPostEdit(stored, { id: stored.id, title: "Welcome all" })).toEqual({
      ...stored,
      title: "Welcome all",
    });
  });

  // The shared writer reads a missing status as draft and a missing cover as
  // none, so this is the line between "fix a typo" and "take the post down".
  it("leaves a live post live and its cover in place when neither is sent", () => {
    const merged = mergeAgentBlogPostEdit(stored, { id: stored.id, body_md: "New body." });
    expect(merged.status).toBe("published");
    expect(merged.cover_image_path).toBe("drafts/cover.jpg");
  });

  it("clears the excerpt and the cover when sent empty", () => {
    const merged = mergeAgentBlogPostEdit(stored, {
      id: stored.id,
      excerpt: "",
      cover_image_path: "",
    });
    expect(merged.excerpt).toBe("");
    expect(merged.cover_image_path).toBe("");
  });

  it("reads a stored null as empty", () => {
    const merged = mergeAgentBlogPostEdit(
      {
        ...stored,
        excerpt: null,
        cover_image_path: null,
        status: "draft",
        seo_title: null,
        seo_description: null,
      },
      { id: stored.id, title: "x" },
    );
    expect(merged).toMatchObject({
      excerpt: "",
      cover_image_path: "",
      status: "draft",
      seo_title: "",
      seo_description: "",
    });
  });

  // The shared writer stores a blank search field as "use the default", so a
  // change that left these out would otherwise wipe what the manager set.
  it("keeps the search title and description unless they are sent", () => {
    const kept = mergeAgentBlogPostEdit(stored, { id: stored.id, body_md: "New body." });
    expect(kept.seo_title).toBe("Welcome to the club");
    expect(kept.seo_description).toBe("What to expect at your first class.");

    const changed = mergeAgentBlogPostEdit(stored, {
      id: stored.id,
      seo_title: "First class",
      seo_description: "",
    });
    expect(changed.seo_title).toBe("First class");
    expect(changed.seo_description).toBe("");
  });

  // The shared writer leaves an omitted kind alone, but this merge is what
  // the writer is handed, so it has to carry the stored kind through: a typo
  // fix on an article must not move it down among the club updates.
  it("keeps an article an article unless kind is sent", () => {
    const article = { ...stored, kind: "article" };
    expect(mergeAgentBlogPostEdit(article, { id: stored.id, body_md: "New body." }).kind).toBe(
      "article",
    );
    expect(mergeAgentBlogPostEdit(article, { id: stored.id, kind: "update" }).kind).toBe("update");
    expect(mergeAgentBlogPostEdit(stored, { id: stored.id, kind: "article" }).kind).toBe("article");
  });
});

describe("projectAgentBlogPost", () => {
  const post = {
    id: "5b0f3c1e-9a8d-4c2b-8e7f-1a2b3c4d5e6f",
    slug: "2026-09-01-welcome",
    title: "Welcome",
    status: "published",
    kind: "update",
    published_at: "2026-09-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };

  it("reports whether a post is an article or a club update", () => {
    expect(projectAgentBlogPost(post).kind).toBe("update");
    expect(projectAgentBlogPost({ ...post, kind: "article" }).kind).toBe("article");
  });

  it("gives a live post its public address on the real site", () => {
    expect(projectAgentBlogPost(post).url).toBe("https://utsjitsu.com.au/blog/2026-09-01-welcome");
  });

  // The public route 404s on a draft, so an address for one is a dead link
  // to whoever it is handed to. The manager's own screen works either way.
  it("gives a draft no public address, only the manager's screen", () => {
    const projected = projectAgentBlogPost({ ...post, status: "draft" });
    expect(projected.url).toBeNull();
    expect(projected.edit_url).toBe(`https://utsjitsu.com.au/manager/blog/${post.id}`);
  });
});

describe("projectAgentCalendarEvent", () => {
  // A 07:30 Sydney class on Thursday 5 November 2026 (AEDT, +11) starts at
  // 20:30 UTC on Wednesday the 4th: the case where an agent doing its own sums
  // tells a manager the wrong day.
  const morning = {
    id: "0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4",
    series_id: null,
    title: "Early Gi",
    description: null,
    instructor_name: null,
    location: "Alumni Green",
    starts_at: "2026-11-04T20:30:00.000Z",
    ends_at: "2026-11-04T21:30:00.000Z",
    status: "scheduled",
    visibility: "public",
    invite_only: false,
  };

  // Invite only is a badge on the date (docs/calendar.md). It hides nothing, so
  // there is no "can anybody see this" answer to work out from the weekly entry,
  // and what is reported is what the date carries, the flag an edit writes.
  it("reports the date's own invite only flag, passed through", () => {
    expect(projectAgentCalendarEvent({ ...morning, invite_only: true }).invite_only).toBe(true);
    expect(projectAgentCalendarEvent({ ...morning, invite_only: false }).invite_only).toBe(false);

    // A row that also says its weekly entry is invite only still reports the
    // date's own flag rather than the entry's.
    const ofInviteOnlyEntry = { ...morning, series_id: "series-1", series_invite_only: true };
    const projected = projectAgentCalendarEvent(ofInviteOnlyEntry);
    expect(projected.invite_only).toBe(false);
    expect(projected).not.toHaveProperty("series_invite_only");
  });

  it("reports the club's wall clock and weekday, not UTC's", () => {
    expect(projectAgentCalendarEvent(morning)).toMatchObject({
      starts_at: morning.starts_at,
      ends_at: morning.ends_at,
      starts_local: "2026-11-05T07:30",
      ends_local: "2026-11-05T08:30",
      weekday: "Thursday",
    });
  });

  it("reads the offset of the season the date is in", () => {
    // The same 07:30 class in winter (AEST, +10).
    const winter = projectAgentCalendarEvent({
      ...morning,
      starts_at: "2026-06-03T21:30:00.000Z",
      ends_at: "2026-06-03T22:30:00.000Z",
    });
    expect(winter).toMatchObject({
      starts_local: "2026-06-04T07:30",
      ends_local: "2026-06-04T08:30",
      weekday: "Thursday",
    });
  });

  // starts_local is the shape create_calendar_entry takes, so a time read back
  // can be sent back unchanged.
  it("gives starts_local in the shape create_calendar_entry takes", () => {
    expect(projectAgentCalendarEvent(morning).starts_local).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
  });

  it("says a date repeats exactly when it belongs to a series", () => {
    expect(projectAgentCalendarEvent(morning).repeats).toBe(false);
    const weekly = projectAgentCalendarEvent({
      ...morning,
      series_id: "9c8b7a6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
    });
    expect(weekly.repeats).toBe(true);
    expect(weekly.series_id).toBe("9c8b7a6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d");
  });

  // The dates create_calendar_entry returns carry no tally, and a zero tally
  // there would claim nobody replied to a date nobody could have seen yet.
  it("carries rsvps only when the date has a tally", () => {
    expect(projectAgentCalendarEvent(morning)).not.toHaveProperty("rsvps");
    const rsvps = { going: 3, maybe: 1, declined: 0 };
    expect(projectAgentCalendarEvent({ ...morning, rsvps }).rsvps).toEqual(rsvps);
  });

  it("passes the screen's details through", () => {
    expect(projectAgentCalendarEvent(morning)).toMatchObject({
      id: morning.id,
      title: "Early Gi",
      status: "scheduled",
      visibility: "public",
      invite_only: false,
      instructor_name: null,
      location: "Alumni Green",
      description: null,
    });
  });
});
