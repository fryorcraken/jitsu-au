import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_KEY_UPLOADER,
  AGENT_MANIFEST,
  AgentError,
  bearerToken,
  buildInvoicePatch,
  classifyAction,
  INVOICE_EDITABLE_FIELDS,
  projectInvoice,
  safeEqual,
} from "./manager-agent";
import { editInvoiceSchema, managerAgentActions, paperWaiverUploadSchema } from "./validation";
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
  const plan = { id: "plan-1", code: "semester", name: "One semester" } as MembershipPlanRow;

  it("formats the price and carries the plan code", () => {
    const p = projectInvoice(membership, plan);
    expect(p.price).toBe("$245");
    expect(p.plan_code).toBe("semester");
    expect(p.id).toBe("abc");
  });

  it("tolerates a missing plan", () => {
    const p = projectInvoice(membership, undefined);
    expect(p.plan_code).toBeNull();
    expect(p.plan_name).toBeNull();
  });
});

describe("AGENT_MANIFEST", () => {
  it("documents exactly the actions the endpoint dispatches", () => {
    const names = AGENT_MANIFEST.actions.map((a) => a.name).sort();
    expect(names).toEqual([...managerAgentActions].sort());
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
