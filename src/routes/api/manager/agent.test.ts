// Route-handler coverage for the two behaviours introduced by the dev-probe
// fixes that have no seam in src/lib/: the 405 response for non-GET/POST
// methods, and list_invoices's count/total split. Both are plain functions on
// the exported Route (no AsyncLocalStorage/Start context involved), so they're
// reachable directly — see membership.functions.test.ts for why that isn't
// true of createServerFn handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result<T> = { data: T | null; error: { message: string } | null };
const ok = <T>(data: T): Result<T> => ({ data, error: null });

const ROW = {
  id: "mem-1",
  user_id: null,
  plan_id: "plan-1",
  status: "active",
  price_cents: 10000,
  payment_reference: null,
  payment_method: null,
  is_student: false,
  paid_at: null,
  starts_at: null,
  ends_at: null,
  sessions_remaining: null,
  notes: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const INVOICE_ID = "63ab09b5-20e4-451a-ad8e-08caa0c299a2";

/** A fake service-role client covering exactly the chains list_invoices walks. */
function fakeAdminForListInvoices(rows: (typeof ROW)[], total: number) {
  const memberships = {
    order: () => memberships,
    eq: () => memberships,
    limit: (n: number) => Promise.resolve(ok(rows.slice(0, n))),
  };
  const membershipsCount = {
    eq: () => membershipsCount,
    then: (resolve: (r: { count: number; error: null }) => void) =>
      resolve({ count: total, error: null }),
  };
  return {
    from: (table: string) => {
      if (table === "memberships") {
        return {
          select: (_cols: string, sel?: { count?: string }) =>
            sel?.count ? membershipsCount : memberships,
        };
      }
      if (table === "membership_plans") {
        return { select: () => Promise.resolve(ok([])) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

/**
 * A fake service-role client covering the chains edit_invoice walks: find the
 * row, update it, then look its plan up to decorate the echo. Records the patch
 * so a test can assert nothing was written when the edit was refused.
 */
function fakeAdminForEditInvoice(existing: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    db: {
      from: (table: string) => {
        if (table === "memberships") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ok(existing)) }) }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              return {
                eq: () => ({
                  select: () => ({
                    single: () => Promise.resolve(ok({ ...existing, ...patch })),
                  }),
                }),
              };
            },
          };
        }
        if (table === "membership_plans") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve(ok({ id: "plan-1", code: "trial" })),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
}

let currentAdmin: unknown;
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentAdmin;
  },
}));

const BREAK_GLASS_KEY = "test-break-glass-key";

type RouteHandler = (ctx: { request: Request }) => Promise<Response>;
type RouteHandlers = Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", RouteHandler>;

async function handlers(): Promise<RouteHandlers> {
  const { Route } = await import("./agent");
  return (Route as unknown as { options: { server: { handlers: RouteHandlers } } }).options.server
    .handlers;
}

async function post(body: unknown) {
  return (await handlers()).POST({
    request: new Request("http://localhost/api/manager/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${BREAK_GLASS_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

async function method(verb: "PUT" | "PATCH" | "DELETE") {
  return (await handlers())[verb]({
    request: new Request("http://localhost/api/manager/agent", { method: verb }),
  });
}

describe("manager agent route", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.MANAGER_AGENT_API_KEY = BREAK_GLASS_KEY;
  });
  afterEach(() => {
    delete process.env.MANAGER_AGENT_API_KEY;
    vi.restoreAllMocks();
  });

  it.each(["PUT", "PATCH", "DELETE"] as const)(
    "rejects %s with 405 and an Allow header, not the GET manifest",
    async (verb) => {
      const res = await method(verb);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, error: { code: "method_not_allowed" } });
    },
  );

  it("reports total distinct from count when a page is capped", async () => {
    currentAdmin = fakeAdminForListInvoices([ROW, ROW, ROW, ROW, ROW], 5);
    const res = await post({ action: "list_invoices", params: { limit: 2 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.count).toBe(2);
    expect(body.result.total).toBe(5);
    expect(body.result.invoices).toHaveLength(2);
  });

  it("makes count and total equal for a full, uncapped page", async () => {
    currentAdmin = fakeAdminForListInvoices([ROW, ROW], 2);
    const res = await post({ action: "list_invoices", params: {} });
    const body = await res.json();
    expect(body.result.count).toBe(2);
    expect(body.result.total).toBe(2);
  });

  // A $0 invoice that was already paid and active silently became a $245 one.
  // The price of a reconciled invoice is a record of money that moved, so it now
  // takes a deliberate flag rather than a bare edit.
  describe("edit_invoice on a paid invoice", () => {
    const PAID = { ...ROW, id: INVOICE_ID, price_cents: 0, paid_at: "2026-07-28T11:06:27.181Z" };

    it("refuses to rewrite the price, naming the field and the flag", async () => {
      const fake = fakeAdminForEditInvoice(PAID);
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, price_cents: 24500 },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("reconciled_invoice");
      expect(body.error.blocked).toEqual(["price_cents"]);
      expect(body.error.previous).toEqual({ price_cents: 0 });
      // And nothing was written.
      expect(fake.updates).toHaveLength(0);
    });

    it("allows the correction when the caller confirms it", async () => {
      const fake = fakeAdminForEditInvoice(PAID);
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, price_cents: 24500, confirm_paid_edit: true },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.invoice.price_cents).toBe(24500);
      expect(body.result.changed).toEqual(["price_cents"]);
      expect(body.result.previous).toEqual({ price_cents: 0 });
      // The flag is a confirmation, never a column.
      expect(fake.updates[0]).toEqual({ price_cents: 24500 });
    });

    it("still lets a manager fix a note, which claims nothing about money", async () => {
      const fake = fakeAdminForEditInvoice(PAID);
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, notes: "cash on the night" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).result.changed).toEqual(["notes"]);
    });

    it("does not trip on a price resubmitted at the value it already holds", async () => {
      const fake = fakeAdminForEditInvoice(PAID);
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, price_cents: 0 },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.changed).toEqual([]);
      expect(body.result.previous).toEqual({});
    });
  });

  it("edits an unpaid invoice's price with no confirmation needed", async () => {
    const fake = fakeAdminForEditInvoice({ ...ROW, id: INVOICE_ID, paid_at: null });
    currentAdmin = fake.db;
    const res = await post({
      action: "edit_invoice",
      params: { id: INVOICE_ID, price_cents: 24500 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.changed).toEqual(["price_cents"]);
    expect(body.result.previous).toEqual({ price_cents: 10000 });
  });

  it("reports a missing invoice as not_found rather than a guard failure", async () => {
    currentAdmin = fakeAdminForEditInvoice(null).db;
    const res = await post({ action: "edit_invoice", params: { id: INVOICE_ID, notes: "x" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});
