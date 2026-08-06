import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_KEY_UPLOADER,
  AGENT_MANIFEST,
  AgentError,
  bearerToken,
  buildInvoicePatch,
  classifyAction,
  diffInvoicePatch,
  INVOICE_EDITABLE_FIELDS,
  invoiceEditAudit,
  projectAgentKbArticle,
  projectInvoice,
  RECONCILED_GUARDED_FIELDS,
  reconciledEditBlockers,
  reconciledEditMessage,
  safeEqual,
} from "./manager-agent";
import { editInvoiceSchema, managerAgentActions, paperWaiverUploadSchema } from "./validation";
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
    expect(AGENT_MANIFEST.version).toBe("8");
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

  it("documents file_waiver's required params in step with the schema", () => {
    const file = AGENT_MANIFEST.actions.find((a) => a.name === "file_waiver")!;
    const documented = new Set(file.params.filter((p) => p.required).map((p) => p.name));
    // The manifest is prose an agent reads before acting; if it stops matching
    // what the Zod schema actually enforces, the endpoint would reject a call
    // the manifest said was fine. emergency_contact_relationship is left off
    // this list on purpose: required only for a minor, and the manifest says
    // so in its description rather than as an unconditional required flag.
    const schemaRequired = new Set([
      "first_name",
      "last_name",
      "date_of_birth",
      "address",
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
  });
});

describe("AGENT_ENV_KEY_UPLOADER", () => {
  it("is not a UUID, so filePaperWaiver knows to skip resolving it to a real user", () => {
    expect(AGENT_ENV_KEY_UPLOADER).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
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
