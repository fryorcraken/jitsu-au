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
  notes: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

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
});
