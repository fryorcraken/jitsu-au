import { describe, expect, it } from "vitest";
import {
  AGENT_MANIFEST,
  AgentError,
  bearerToken,
  buildInvoicePatch,
  INVOICE_EDITABLE_FIELDS,
  projectInvoice,
  safeEqual,
} from "./manager-agent";
import { editInvoiceSchema, managerAgentActions } from "./validation";
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
});

describe("buildInvoicePatch", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  it("includes only the fields that were supplied", () => {
    const patch = buildInvoicePatch({ id, notes: "called member", status: "cancelled" });
    expect(patch).toEqual({ notes: "called member", status: "cancelled" });
    expect("price_cents" in patch).toBe(false);
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
});

describe("AgentError", () => {
  it("carries an http status and a machine code", () => {
    const e = new AgentError(401, "unauthorized", "nope");
    expect(e.httpStatus).toBe(401);
    expect(e.code).toBe("unauthorized");
    expect(e).toBeInstanceOf(Error);
  });
});
