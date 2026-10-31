// Route-handler coverage for the two behaviours introduced by the dev-probe
// fixes that have no seam in src/lib/: the 405 response for non-GET/POST
// methods, and list_invoices's count/total split. Both are plain functions on
// the exported Route (no AsyncLocalStorage/Start context involved), so they're
// reachable directly — see membership.functions.test.ts for why that isn't
// true of createServerFn handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/lib/manager-api-tokens";
import { WEEKDAY_LABELS } from "@/lib/calendar";
import { AGENT_MANIFEST } from "@/lib/manager-agent";

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
        // `.eq("kind", "insurance")` is the reminder-state lookup asking which
        // plans are yearly insurance. None here, so it reads nothing more.
        const plans = Object.assign(Promise.resolve(ok([])), {
          eq: () => Promise.resolve(ok([])),
        });
        return { select: () => plans };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

/**
 * A fake service-role client covering the chains edit_invoice walks: find the
 * row, update it, then look its plan up to decorate the echo. Records the patch
 * so a test can assert nothing was written when the edit was refused.
 *
 * The update chain EVALUATES its filters rather than ignoring them, against
 * `atWriteTime` (defaulting to `existing`). That is what makes the
 * compare-and-swap tests real: a fake that always returned a row would pass
 * just as happily with the guard deleted, which is the trap this whole PR keeps
 * finding in its own tests. Pass a different `atWriteTime` to model another
 * writer landing between the read and the write.
 */
function fakeAdminForEditInvoice(
  existing: Record<string, unknown> | null,
  atWriteTime?: Record<string, unknown> | null,
  // The plan behind the invoice. It decides one thing on its own: whether this
  // membership has a start date to set at all, which is a property of the plan's
  // window and not of the row being edited.
  plan: Record<string, unknown> = { id: "plan-1", code: "trial" },
) {
  const updates: Record<string, unknown>[] = [];
  const current = atWriteTime === undefined ? existing : atWriteTime;
  return {
    updates,
    db: {
      from: (table: string) => {
        if (table === "memberships") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ok(existing)) }) }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              const filters: [string, unknown][] = [];
              const chain = {
                eq: (col: string, val: unknown) => {
                  filters.push([col, val]);
                  return chain;
                },
                is: (col: string, val: unknown) => {
                  filters.push([col, val]);
                  return chain;
                },
                select: () => chain,
                maybeSingle: () => {
                  if (!current) return Promise.resolve(ok(null));
                  const matches = filters.every(([col, val]) =>
                    col === "id" ? current.id === val : (current[col] ?? null) === val,
                  );
                  return Promise.resolve(ok(matches ? { ...current, ...patch } : null));
                },
              };
              return chain;
            },
          };
        }
        if (table === "membership_plans") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve(ok(plan)),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
}

/**
 * The reads `create_membership` walks before it can refuse a start date: the
 * plan named by `plan_code`, and the insurance catalogue `resolveInsuranceCover`
 * checks on the way past. Nothing else is reached, because the refusal lands
 * before a single write.
 */
function fakeAdminForCreateMembership(plan: Record<string, unknown>) {
  return {
    from: (table: string) => {
      if (table === "membership_plans") {
        return {
          select: () => ({
            eq: (col: string) =>
              col === "code"
                ? { maybeSingle: () => Promise.resolve(ok(plan)) }
                : // resolveInsuranceCover awaits the kind filter directly.
                  Promise.resolve(ok([])),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

let currentAdmin: unknown;
/** What the has_role re-check answers. Only the upload link tests turn it off. */
let stillManager = true;
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return withMintedToken(currentAdmin);
  },
}));

// filePaperWaiver's own behaviour is covered in waiver.functions.test.ts. What
// is mocked here is only the throw, so these tests pin the one thing the route
// owns: which HTTP status and payload each failure becomes. That mapping is what
// the skill tells agents to branch on — 503 retry, 409 stop and confirm — so a
// silent collapse to 422 turns a transient outage into an abandoned record.
const filePaperWaiverMock = vi.fn();
// The waiver-template functions are mocked for the same reason: their own
// behaviour (refuse before writing, insert then promote) is pinned in
// waiver-template.functions.test.ts against a store-backed fake. What the route
// owns, and what these tests pin, is which version an omitted field is carried
// over FROM, and whether a call that changed nothing says so.
const listWaiverTemplateRowsMock = vi.fn();
const loadWaiverTemplateVersionMock = vi.fn();
const saveWaiverTemplateVersionMock = vi.fn();
const promoteWaiverTemplateMock = vi.fn();
vi.mock("@/lib/waiver.functions", () => ({
  filePaperWaiver: (...args: unknown[]) => filePaperWaiverMock(...args),
  listWaiverTemplateRows: (...args: unknown[]) => listWaiverTemplateRowsMock(...args),
  loadWaiverTemplateVersion: (...args: unknown[]) => loadWaiverTemplateVersionMock(...args),
  saveWaiverTemplateVersion: (...args: unknown[]) => saveWaiverTemplateVersionMock(...args),
  promoteWaiverTemplate: (...args: unknown[]) => promoteWaiverTemplateMock(...args),
}));

// The code-of-conduct store's own behaviour (numbering, draft-then-promote, the
// replayed submission id) is pinned in code-of-conduct.functions.test.ts. What
// the route owns, and what is pinned here, is the carry-over, the re-prompt
// count, and which status each refusal becomes. Everything not named here is
// the real module, so list_users still measures against the real standard.
const listCodeOfConductVersionRowsMock = vi.fn();
const listCodeOfConductVersionFlagsMock = vi.fn();
const listCodeOfConductVersionSummariesMock = vi.fn();
const loadCodeOfConductVersionMock = vi.fn();
const saveCodeOfConductVersionMock = vi.fn();
const promoteCodeOfConductVersionMock = vi.fn();
const highestAcceptedVersionsMock = vi.fn();
vi.mock("@/lib/code-of-conduct.functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-of-conduct.functions")>()),
  listCodeOfConductVersionRows: (...args: unknown[]) => listCodeOfConductVersionRowsMock(...args),
  listCodeOfConductVersionFlags: (...args: unknown[]) => listCodeOfConductVersionFlagsMock(...args),
  listCodeOfConductVersionSummaries: (...args: unknown[]) =>
    listCodeOfConductVersionSummariesMock(...args),
  loadCodeOfConductVersion: (...args: unknown[]) => loadCodeOfConductVersionMock(...args),
  saveCodeOfConductVersion: (...args: unknown[]) => saveCodeOfConductVersionMock(...args),
  promoteCodeOfConductVersion: (...args: unknown[]) => promoteCodeOfConductVersionMock(...args),
  highestAcceptedVersions: (...args: unknown[]) => highestAcceptedVersionsMock(...args),
}));

// Publishing a post announces it. The announcement's own fan-out is covered in
// the notification tests; what the blog actions own is whether it is asked for.
const notifyNewBlogPostMock = vi.fn();
vi.mock("@/lib/notification-events.server", () => ({
  notifyNewBlogPost: (...args: unknown[]) => notifyNewBlogPostMock(...args),
}));

// The announcement's own behaviour (who is emailed, retries, pending rows) is
// pinned in plan-announcement.server.test.ts. What the route owns is the
// sequencing around it: refuse before saving, save, then announce, and say the
// plan is saved when only the email failed.
const announceMembershipPlanMock = vi.fn();
vi.mock("@/lib/plan-announcement.server", () => {
  class PlanAnnouncementError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    PlanAnnouncementError,
    announceMembershipPlan: (...args: unknown[]) => announceMembershipPlanMock(...args),
    loadAnnouncementSummaries: async () => new Map(),
  };
});

const MINTED_TOKEN = "utsj_0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN_OWNER = "44444444-4444-4444-4444-444444444444";
/**
 * Shaped like something somebody would have put in MANAGER_AGENT_API_KEY. It is
 * never minted, so the endpoint must refuse it — that env fallback is gone.
 */
const ENV_STYLE_KEY = "test-break-glass-key";

/**
 * The manager_api_tokens chains `authenticate` walks: look the token up by
 * hash, then stamp last_used_at.
 *
 * It really compares the hash rather than waving any bearer token through. A
 * fake that returned the row unconditionally would pass just as happily with
 * the whole minted-token lookup deleted, which is exactly the assertion the
 * env-key tests below depend on.
 */
function fakeTokensTable() {
  let hash: string | null = null;
  const select = {
    eq: (col: string, val: string) => {
      if (col === "token_hash") hash = val;
      return select;
    },
    is: () => select,
    maybeSingle: async () =>
      ok(
        hash === (await hashToken(MINTED_TOKEN)) ? { id: "tok-1", created_by: TOKEN_OWNER } : null,
      ),
  };
  const stamp = {
    eq: () => stamp,
    then: (resolve: (r: Result<unknown>) => void) => resolve(ok(null)),
  };
  return { select: () => select, update: () => stamp };
}

/**
 * Wrap a fake service-role client so it can also answer the two calls
 * `authenticate` makes before any action runs: the hashed-token lookup and the
 * has_role re-check of the token's owner. Every fake below models only the
 * tables its own action walks, so without this each of them would throw
 * "unexpected table manager_api_tokens" at the door instead of running.
 */
function withMintedToken(db: unknown) {
  const base = (db ?? {}) as {
    from?: (table: string) => unknown;
    rpc?: (name: string, args?: unknown) => unknown;
  };
  return {
    ...base,
    from: (table: string) => {
      if (table === "manager_api_tokens") return fakeTokensTable();
      if (!base.from) throw new Error(`unexpected table ${table}`);
      return base.from(table);
    },
    rpc: (name: string, args?: unknown) => {
      if (name === "has_role") return Promise.resolve(ok(stillManager));
      if (!base.rpc) throw new Error(`unexpected rpc ${name}`);
      return base.rpc(name, args);
    },
  };
}

type RouteHandler = (ctx: { request: Request }) => Promise<Response>;
type RouteHandlers = Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", RouteHandler>;

async function handlers(): Promise<RouteHandlers> {
  const { Route } = await import("./agent");
  return (Route as unknown as { options: { server: { handlers: RouteHandlers } } }).options.server
    .handlers;
}

async function post(body: unknown, token: string = MINTED_TOKEN) {
  return (await handlers()).POST({
    request: new Request("http://localhost/api/manager/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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
  });
  afterEach(() => {
    delete process.env.MANAGER_AGENT_API_KEY;
    vi.restoreAllMocks();
  });

  // A minted, hashed manager_api_tokens row is now the ONLY credential this
  // endpoint accepts. It used to take a MANAGER_AGENT_API_KEY env var as well,
  // which was checked FIRST, stored in plaintext, revocable only by redeploy,
  // and attributed to nobody — so a waiver filed through it named no auth user.
  // Setting that variable must do nothing at all now, or the removal is
  // reversible by anyone who can edit an environment.
  describe("authentication", () => {
    it("refuses an env-style key even when MANAGER_AGENT_API_KEY is set to it", async () => {
      process.env.MANAGER_AGENT_API_KEY = ENV_STYLE_KEY;
      // A fake with no tables but the token lookup: reaching any action at all
      // would throw "unexpected table", so a 401 proves it stopped at the door.
      currentAdmin = {};
      const res = await post({ action: "list_invoices", params: {} }, ENV_STYLE_KEY);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    });

    it("refuses any token that hashes to no unrevoked row", async () => {
      currentAdmin = {};
      const res = await post({ action: "list_invoices", params: {} }, "utsj_not-a-minted-token");
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("unauthorized");
    });

    it("still refuses a request with no bearer token at all", async () => {
      currentAdmin = {};
      const res = await (
        await handlers()
      ).POST({
        request: new Request("http://localhost/api/manager/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "list_invoices", params: {} }),
        }),
      });
      expect(res.status).toBe(401);
    });
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
    // Not yearly insurance, so there is no reminder to report.
    expect(body.result.invoices[0].insurance_reminder).toBeNull();
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
      expect(body.error.details.blocked).toEqual(["price_cents"]);
      expect(body.error.details.previous).toEqual({ price_cents: 0 });
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

    // The refusal is atomic, and `previous` must line up with `blocked` — a
    // caller reading the two together would otherwise take the note's old value
    // as part of what was refused.
    it("refuses the whole call, echoing previous only for the blocked fields", async () => {
      const fake = fakeAdminForEditInvoice({ ...PAID, notes: "old text" });
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, price_cents: 500, notes: "typo" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.details.blocked).toEqual(["price_cents"]);
      expect(body.error.details.previous).toEqual({ price_cents: 0 });
      expect(body.error.details.previous).not.toHaveProperty("notes");
      // Nothing written, including the unguarded field sent alongside.
      expect(fake.updates).toHaveLength(0);
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

  // The guard reads paid_at, then writes. A reconciliation landing in between
  // would otherwise let a guarded edit through against an invoice that became
  // paid after the check said it was not.
  it("refuses the write if the invoice was reconciled between the check and the update", async () => {
    const fake = fakeAdminForEditInvoice(
      { ...ROW, id: INVOICE_ID, paid_at: null },
      // A payment reconciled after the guard read the row as unpaid.
      { ...ROW, id: INVOICE_ID, paid_at: "2026-07-28T11:06:27.181Z" },
    );
    currentAdmin = fake.db;
    const res = await post({
      action: "edit_invoice",
      params: { id: INVOICE_ID, price_cents: 24500 },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("invoice_changed");
    // Tells the caller to re-read rather than blindly retry into the same race.
    expect(body.error.message).toMatch(/read it again/i);
  });

  // Without pinning the edited columns too, this call would succeed and log
  // `"cash" -> "card"` — a transition that never happened, in the club's only
  // record of who changed an invoice.
  it("refuses the write if an edited field moved under it, so the audit cannot lie", async () => {
    const fake = fakeAdminForEditInvoice(
      { ...ROW, id: INVOICE_ID, paid_at: null, notes: "cash" },
      // Another manager got there first.
      { ...ROW, id: INVOICE_ID, paid_at: null, notes: "cheque" },
    );
    currentAdmin = fake.db;
    const res = await post({
      action: "edit_invoice",
      params: { id: INVOICE_ID, notes: "card" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("invoice_changed");
  });

  // ---- Correcting the day a membership starts ----
  //
  // The manager's counterpart is the Start date button on the membership row;
  // both land the same two columns through the same rule, so cover cannot be
  // lengthened by correcting when it began.
  describe("edit_invoice starts_on", () => {
    const YEARLY = {
      id: "plan-1",
      code: "insurance_yearly",
      name: "Yearly insurance",
      kind: "insurance",
      starts_on: null,
      ends_on: null,
      duration_days: 365,
    };
    // Spelled the way PostgREST renders a TIMESTAMPTZ (`+00:00`, no fractional
    // part), NOT the way JS writes one. A fixture in the write format hides the
    // one bug these tests exist to catch: the same instant compared as two
    // different strings, reported as an edit that never happened.
    const COVER = {
      ...ROW,
      id: INVOICE_ID,
      paid_at: null,
      // A real backdated year of cover: club midnight to club midnight, spelled
      // the way PostgREST renders a TIMESTAMPTZ. 00:00 on 1 May in Sydney is
      // 14:00 the day before in UTC (AEST, +10).
      starts_at: "2026-04-30T14:00:00+00:00",
      ends_at: "2027-04-30T14:00:00+00:00",
    };

    it("moves both ends of the window, and reports both as changed", async () => {
      const fake = fakeAdminForEditInvoice(COVER, undefined, YEARLY);
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, starts_on: "2026-02-01" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // 00:00 Sydney on 1 February, and 365 days later: the length it was sold at.
      expect(fake.updates[0]).toEqual({
        starts_at: "2026-01-31T13:00:00.000Z",
        ends_at: "2027-01-31T13:00:00.000Z",
      });
      expect(body.result.changed).toEqual(["starts_at", "ends_at"]);
      expect(body.result.previous).toEqual({
        starts_at: "2026-04-30T14:00:00+00:00",
        ends_at: "2027-04-30T14:00:00+00:00",
      });
    });

    // Not ignored: an agent told "ok" would report a training period as
    // backdated when nothing moved.
    it("refuses a plan whose dates belong to the plan, and writes nothing", async () => {
      const fake = fakeAdminForEditInvoice(COVER, undefined, {
        id: "plan-1",
        name: "Semester 2 2026",
        kind: "period",
        starts_on: "2026-07-20",
        ends_on: "2026-11-22",
        duration_days: null,
      });
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, starts_on: "2026-02-01" },
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("start_date_not_choosable");
      expect(body.error.message).toContain("Semester 2 2026");
      expect(fake.updates).toHaveLength(0);
    });

    // The case this exists for: cover settled in March, recorded in April, dated
    // from the day the manager got to it. Guarding the dates behind
    // confirm_paid_edit would refuse exactly that.
    it("corrects a PAID invoice's dates without confirm_paid_edit", async () => {
      const fake = fakeAdminForEditInvoice(
        { ...COVER, paid_at: "2026-05-02T00:00:00.000Z" },
        undefined,
        YEARLY,
      );
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, starts_on: "2026-02-01" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).result.changed).toEqual(["starts_at", "ends_at"]);
    });

    // The same instant, spelled as Postgres returns it. A string compare would
    // call this an edit and write a move that never happened into the audit log.
    it("treats the day it already starts on as no edit at all", async () => {
      const fake = fakeAdminForEditInvoice(
        { ...COVER, starts_at: "2026-01-31T13:00:00+00:00", ends_at: "2027-01-31T13:00:00+00:00" },
        undefined,
        YEARLY,
      );
      currentAdmin = fake.db;
      const res = await post({
        action: "edit_invoice",
        params: { id: INVOICE_ID, starts_on: "2026-02-01" },
      });
      expect(res.status).toBe(200);
      // `changed` empty is the assertion that matters: it is what the audit log
      // records, and a move that never happened must not appear in it. The patch
      // itself still carries the field, exactly as a price resubmitted at its
      // current value does.
      expect((await res.json()).result.changed).toEqual([]);
    });
  });

  // The refusal has to reach a caller as a 422 it can act on, not the 500 an
  // unrecognised throw becomes — and it has to say the same thing edit_invoice
  // says, since it is the same rule about the same plan.
  it("refuses create_membership's start date on a plan that has none, as a 422", async () => {
    currentAdmin = fakeAdminForCreateMembership({
      id: "plan-period",
      code: "2026-s2",
      name: "Semester 2 2026",
      kind: "period",
      starts_on: "2026-07-20",
      ends_on: "2026-11-22",
      duration_days: null,
      session_credits: null,
      public_price_cents: 24500,
      student_price_cents: null,
      is_active: true,
      sort_order: 0,
    });
    const res = await post({
      action: "create_membership",
      params: {
        user_id: "22222222-2222-4222-8222-222222222222",
        plan_code: "2026-s2",
        starts_on: "2026-02-01",
      },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("start_date_not_choosable");
    expect(body.error.message).toContain("Semester 2 2026");
    expect(body.error.details.plan_kind).toBe("period");
  });

  it("reports a missing invoice as not_found rather than a guard failure", async () => {
    currentAdmin = fakeAdminForEditInvoice(null).db;
    const res = await post({ action: "edit_invoice", params: { id: INVOICE_ID, notes: "x" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  describe("file_waiver failure mapping", () => {
    const params = {
      first_name: "Ada",
      last_name: "Lovelace",
      date_of_birth: "1990-12-10",
      address: "1 Broadway, Ultimo NSW",
      phone: "0400000000",
      email: "ada@example.com",
      emergency_contact_name: "Charles Babbage",
      emergency_contact_phone: "0400000001",
      signed_on: "2020-01-15",
      scan: [{ name: "w.pdf", type: "application/pdf", data: "aGlw" }],
    };

    beforeEach(() => {
      currentAdmin = {};
      filePaperWaiverMock.mockReset();
    });

    it("maps a duplicate to 409 with the colliding waivers, not a generic failure", async () => {
      const { DuplicateWaiverError } = await import("@/lib/waiver-duplicates");
      const rows = [{ id: "w-1", approval_status: "pending", signed_on: "2020-01-15" }];
      filePaperWaiverMock.mockRejectedValue(new DuplicateWaiverError(rows));

      const res = await post({ action: "file_waiver", params });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("duplicate_waiver");
      // The ids are the actionable part: without them a caller cannot go and
      // look at what it collided with.
      expect(body.error.details.existing).toEqual(rows);
      expect(body.error.details.truncated).toBe(false);
    });

    it("passes truncation through so a caller is not told a capped count is the total", async () => {
      const { DuplicateWaiverError } = await import("@/lib/waiver-duplicates");
      const rows = [{ id: "w-1", approval_status: "pending", signed_on: "2020-01-15" }];
      filePaperWaiverMock.mockRejectedValue(new DuplicateWaiverError(rows, true));

      const body = await (await post({ action: "file_waiver", params })).json();
      expect(body.error.details.truncated).toBe(true);
    });

    // 503, not 4xx: the request is fine and nothing was filed, so the agent
    // should repeat it unchanged rather than treat the record as rejected.
    it("maps a failed duplicate probe to a retryable 503, distinct from a bad scan", async () => {
      const { DuplicateCheckFailedError } = await import("@/lib/waiver-duplicates");
      filePaperWaiverMock.mockRejectedValue(new DuplicateCheckFailedError());

      const res = await post({ action: "file_waiver", params });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("duplicate_check_failed");
      expect(res.headers.get("retry-after")).toBe("5");
      // Must not point the caller at the flag that would disable the check.
      expect(body.error.message).not.toMatch(/confirm_duplicate/);
    });

    it("still maps an ordinary filing failure to 422", async () => {
      filePaperWaiverMock.mockRejectedValue(new Error("scan[0] is not valid base64."));
      const res = await post({ action: "file_waiver", params });
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("file_waiver_failed");
    });

    // A half-filed row is completed ONLY by retrying with the same id, so this
    // must read as 5xx. As a 422 it told a caller obeying the documented "4xx
    // means change the request" rule to change the one thing it could — the id
    // — filing a second waiver against the same paper.
    it("maps an unfinished filing to a retryable 503, not the generic 422", async () => {
      const { WaiverFilingIncompleteError } = await import("@/lib/waiver-duplicates");
      filePaperWaiverMock.mockRejectedValue(
        new WaiverFilingIncompleteError("The scan could not be stored."),
      );
      const res = await post({ action: "file_waiver", params });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("waiver_filing_incomplete");
      expect(res.headers.get("retry-after")).toBe("5");
    });

    // The opposite: permanent. It must not share a code with the retryable ones,
    // or a caller cannot tell "retry unchanged" from "your ids are wrong".
    it("maps an id bound to another record to a permanent 409", async () => {
      const { SubmissionIdConflictError } = await import("@/lib/waiver-duplicates");
      filePaperWaiverMock.mockRejectedValue(new SubmissionIdConflictError());
      const res = await post({ action: "file_waiver", params });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("submission_id_conflict");
      expect(res.headers.get("retry-after")).toBeNull();
    });

    it("returns the filed waiver on success, saying whether this call created it", async () => {
      filePaperWaiverMock.mockResolvedValue({ id: "w-9", user_id: "u-9", created: true });
      const res = await post({ action: "file_waiver", params });
      expect(res.status).toBe(200);
      expect((await res.json()).result).toEqual({ id: "w-9", user_id: "u-9", created: true });
    });

    it("reports a replay so a partially retried import can be reconciled", async () => {
      filePaperWaiverMock.mockResolvedValue({ id: "w-9", user_id: "u-9", created: false });
      const body = await (await post({ action: "file_waiver", params })).json();
      expect(body.result.created).toBe(false);
    });
  });
});

describe("manager agent route: the waiver template", () => {
  const MEDIA = { id: "media", label: "I consent to being photographed.", required: false };
  const LIVE = {
    id: "11111111-1111-4111-8111-111111111111",
    version: 4,
    title: "Training Waiver",
    body_md: "The whole legal text, {{full_name}}.",
    acknowledgements: [MEDIA],
    is_current: true,
    created_at: "2026-08-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.resetModules();
    currentAdmin = {};
    listWaiverTemplateRowsMock.mockReset();
    loadWaiverTemplateVersionMock.mockReset();
    saveWaiverTemplateVersionMock.mockReset();
    promoteWaiverTemplateMock.mockReset();
  });

  /**
   * Build a refusal from the SAME module registry the route will import from.
   *
   * `vi.resetModules()` in beforeEach gives each test a fresh registry, so an
   * error built from a top-level import is an instance of a different class
   * than the route's `instanceof` check sees, and every mapping would silently
   * fall through to the 500 branch — the test would pass on a broken mapper
   * only if the mapper were broken in the same direction.
   */
  async function refusal(
    message: string,
    reason: "not_found" | "invalid" | "not_published",
    version?: number,
  ) {
    const { DocumentVersionError } = await import("@/lib/document-versions");
    return new DocumentVersionError(message, reason, version);
  }

  it("lists versions without their bodies, naming the live one", async () => {
    listWaiverTemplateRowsMock.mockResolvedValue([
      { ...LIVE, version: 5, is_current: false, id: "b" },
      LIVE,
    ]);
    const res = await post({ action: "list_waiver_templates", params: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.live_version).toBe(4);
    expect(body.result.count).toBe(2);
    expect(body.result.templates[0]).not.toHaveProperty("body_md");
  });

  it("404s a version that does not exist", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue(null);
    const res = await post({ action: "get_waiver_template", params: { version: 99 } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain("99");
  });

  // The outage, not a tidy empty state: /waiver refuses to render without a live
  // template, so the reply has to say what to do about it.
  it("says nobody can sign when nothing is live", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue(null);
    const res = await post({ action: "get_waiver_template", params: {} });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/nobody can sign/);
  });

  // The carry-over is the whole point of the optional fields: rewording one
  // acknowledgement must not mean resending 30000 characters of legal text, and
  // the text it keeps has to come from the version named, not the newest.
  it("carries the body over from the live version when only acknowledgements change", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue(LIVE);
    saveWaiverTemplateVersionMock.mockResolvedValue({ id: "new", version: 5 });
    const reworded = [{ ...MEDIA, label: "I consent to photos and video." }];
    const res = await post({
      action: "save_waiver_template",
      params: { acknowledgements: reworded },
    });
    expect(res.status).toBe(200);
    expect(loadWaiverTemplateVersionMock).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(saveWaiverTemplateVersionMock.mock.calls[0][1]).toEqual({
      title: LIVE.title,
      body_md: LIVE.body_md,
      acknowledgements: reworded,
    });
    const body = await res.json();
    expect(body.result).toMatchObject({ version: 5, based_on: 4, is_current: true });
  });

  it("starts from the version named by base_version, not the live one", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue({ ...LIVE, version: 2, is_current: false });
    saveWaiverTemplateVersionMock.mockResolvedValue({ id: "new", version: 6 });
    const res = await post({
      action: "save_waiver_template",
      params: { acknowledgements: [MEDIA], base_version: 2 },
    });
    expect(res.status).toBe(200);
    expect(loadWaiverTemplateVersionMock).toHaveBeenCalledWith(expect.anything(), 2);
    expect((await res.json()).result.based_on).toBe(2);
  });

  // A caller that described a whole version needs nothing to copy from, and a
  // club whose live template has gone missing must still be able to write one.
  it("writes a complete version without reading a base", async () => {
    saveWaiverTemplateVersionMock.mockResolvedValue({ id: "new", version: 1 });
    const res = await post({
      action: "save_waiver_template",
      params: { title: "Training Waiver", body_md: "Text", acknowledgements: [MEDIA] },
    });
    expect(res.status).toBe(200);
    expect(loadWaiverTemplateVersionMock).not.toHaveBeenCalled();
    expect((await res.json()).result.based_on).toBeNull();
  });

  it("reports a refused save as the caller's to fix", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue(LIVE);
    saveWaiverTemplateVersionMock.mockRejectedValue(
      await refusal(
        "This version has no media consent acknowledgement (or its wording is blank).",
        "invalid",
      ),
    );
    const res = await post({
      action: "save_waiver_template",
      params: { acknowledgements: [{ id: "risk", label: "I accept the risks.", required: true }] },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("save_waiver_template_failed");
    expect(body.error.message).toContain("media consent");
  });

  // The one that must not be a 4xx: the skill tells agents a 4xx means the
  // request has to change, so an unpublished version reported as one leaves
  // /waiver possibly down with nobody retrying — and a caller that DOES retry
  // the save files a second draft of wording that is already written.
  it("reports a version written but not published as a retryable 503", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue(LIVE);
    saveWaiverTemplateVersionMock.mockRejectedValue(
      await refusal("Someone else changed the live waiver a moment ago.", "not_published", 5),
    );
    const res = await post({
      action: "save_waiver_template",
      params: { acknowledgements: [MEDIA] },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = await res.json();
    expect(body.error.code).toBe("waiver_template_not_published");
    expect(body.error.details).toEqual({ version: 5, published: false });
  });

  it("404s a version that vanished between the read and the publish", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue({ ...LIVE, version: 2, is_current: false });
    promoteWaiverTemplateMock.mockRejectedValue(
      await refusal("That waiver version no longer exists.", "not_found"),
    );
    const res = await post({ action: "publish_waiver_template", params: { version: 2 } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("publishes a stored version", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue({ ...LIVE, version: 2, is_current: false });
    promoteWaiverTemplateMock.mockResolvedValue({ version: 2 });
    const res = await post({ action: "publish_waiver_template", params: { version: 2 } });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ version: 2, published: true });
  });

  // Promoting is idempotent, so a retry would otherwise report a second change
  // to the club's legal document that never happened.
  it("changes nothing, and says so, for the version already live", async () => {
    loadWaiverTemplateVersionMock.mockResolvedValue(LIVE);
    const res = await post({ action: "publish_waiver_template", params: { version: 4 } });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ version: 4, published: false });
    expect(promoteWaiverTemplateMock).not.toHaveBeenCalled();
  });
});

describe("manager agent route: item invoices", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ITEM_INVOICE_ID = "7d4b6f0e-3a39-4a77-9d8b-2a1c1f0e5b11";

  /** A fake whose item_invoices table holds one row (or none) and records writes. */
  function fakeItemInvoices(row: Record<string, unknown> | null) {
    const writes: string[] = [];
    const patches: unknown[] = [];
    const chain = (op: string): Record<string, unknown> => {
      const c: Record<string, unknown> = {};
      for (const m of ["eq", "is", "select"]) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve(ok(row));
      c.then = (resolve: (r: unknown) => void) => {
        writes.push(op);
        resolve(ok([{ id: ITEM_INVOICE_ID }]));
      };
      return c;
    };
    return {
      writes,
      patches,
      db: {
        from: (table: string) => {
          if (table !== "item_invoices") throw new Error(`unexpected table ${table}`);
          return {
            select: () => chain("select"),
            update: (patch: unknown) => {
              patches.push(patch);
              return chain("update");
            },
            delete: () => chain("delete"),
          };
        },
      },
    };
  }

  const PAID = {
    id: ITEM_INVOICE_ID,
    payment_reference: "INV0007",
    user_id: null,
    lines: [{ name: "Club gi", unit_price_cents: 8500, quantity: 1 }],
    total_cents: 8500,
    paid_at: "2026-10-01T00:00:00Z",
    cancelled_at: null,
  };

  // A paid invoice is the club's record of money. The refusal has to reach a
  // caller as something it can act on (stop), not a 500 to retry.
  it.each(["delete_item_invoice", "cancel_item_invoice"])(
    "refuses %s on a paid invoice as 409 item_invoice_settled, writing nothing",
    async (action) => {
      const fake = fakeItemInvoices(PAID);
      currentAdmin = fake.db;
      const res = await post({ action, params: { id: ITEM_INVOICE_ID } });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("item_invoice_settled");
      expect(fake.writes).toEqual([]);
    },
  );

  // Cash taken last month and entered today keeps its real day, as noon in
  // Sydney, with the receipt number beside it.
  it("records the day and reference sent with mark_item_invoice_paid", async () => {
    const { CLUB_TIME_ZONE, zonedWallTimeToUtc } = await import("@/lib/calendar");
    const day = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const fake = fakeItemInvoices({ ...PAID, paid_at: null });
    currentAdmin = fake.db;
    const res = await post({
      action: "mark_item_invoice_paid",
      params: { id: ITEM_INVOICE_ID, paid_on: day, paid_reference: "Receipt 42" },
    });
    expect(res.status).toBe(200);
    expect(fake.patches).toEqual([
      {
        paid_at: zonedWallTimeToUtc(day, "12:00", CLUB_TIME_ZONE).toISOString(),
        payment_method: "manual",
        paid_reference: "Receipt 42",
      },
    ]);
  });

  it("refuses a paid_on that has not happened yet, writing nothing", async () => {
    const fake = fakeItemInvoices({ ...PAID, paid_at: null });
    currentAdmin = fake.db;
    const res = await post({
      action: "mark_item_invoice_paid",
      params: { id: ITEM_INVOICE_ID, paid_on: "2999-01-01" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_params");
    expect(fake.writes).toEqual([]);
  });

  it("reports an unknown item invoice as not_found", async () => {
    currentAdmin = fakeItemInvoices(null).db;
    const res = await post({ action: "mark_item_invoice_paid", params: { id: ITEM_INVOICE_ID } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  // The price comes off the price list. A caller sending one must hear that it
  // was not used, not have it silently dropped.
  it("refuses a price sent with a line of create_item_invoice", async () => {
    currentAdmin = {};
    const res = await post({
      action: "create_item_invoice",
      params: {
        user_id: "22222222-2222-4222-8222-222222222222",
        lines: [{ item_id: ITEM_INVOICE_ID, quantity: 1, unit_price_cents: 1 }],
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_params");
  });
});

// ---- Reading people: list_users and get_user ----
//
// Both run their REAL reads (`loadClubUser` for get_user) against a fake over
// in-memory tables, because the point of get_user is that it is the person
// page's own read: mocking that away would test a route nobody runs.
describe("manager agent route: reading people", () => {
  const PERSON = "11111111-1111-4111-8111-111111111111";
  const GUARDIAN = "22222222-2222-4222-8222-222222222222";
  const CHILD = "33333333-3333-4333-8333-333333333333";

  type Row = Record<string, unknown>;

  /** Honours `eq` / `in` and the `count` + `head` select; order and limit are no-ops. */
  function fakeTables(
    tables: Record<string, Row[]>,
    opts: {
      emails?: { user_id: string; email: string; email_confirmed_at: string | null }[];
      fail?: Record<string, string>;
    } = {},
  ) {
    return {
      from: (table: string) => {
        const filters: ((r: Row) => boolean)[] = [];
        let head = false;
        const result = () => {
          if (opts.fail?.[table]) {
            return { data: null, count: null, error: { message: opts.fail[table] } };
          }
          const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          // PostgREST's response cap, which it applies without an error: a read
          // that does not page sees only the first 1000 rows.
          const page = rows.slice(span[0], Math.min(span[1] + 1, span[0] + 1000));
          return { data: head ? null : page, count: rows.length, error: null };
        };
        let span: [number, number] = [0, Infinity];
        const b = {
          select: (_c?: string, o?: { head?: boolean }) => {
            if (o?.head) head = true;
            return b;
          },
          eq: (col: string, val: unknown) => {
            filters.push((r) => r[col] === val);
            return b;
          },
          in: (col: string, vals: unknown[]) => {
            filters.push((r) => vals.includes(r[col]));
            return b;
          },
          order: () => b,
          limit: () => b,
          range: (from: number, to: number) => {
            span = [from, to];
            return b;
          },
          maybeSingle: () => {
            const r = result();
            return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
          },
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result()).then(resolve, reject),
        };
        return b;
      },
      rpc: (name: string, args?: unknown) => {
        if (name !== "user_emails") throw new Error(`unexpected rpc ${name}`);
        const ids = (args as { _user_ids: string[] })._user_ids;
        return Promise.resolve(ok((opts.emails ?? []).filter((e) => ids.includes(e.user_id))));
      },
    };
  }

  const profile = (user_id: string, first_name: string, over: Row = {}): Row => ({
    user_id,
    first_name,
    middle_name: null,
    last_name: "Lovelace",
    preferred_name: null,
    phone: "0400 000 001",
    guardian_user_id: null,
    created_at: "2026-01-01T00:00:00+00:00",
    ...over,
  });

  const tables = (over: Record<string, Row[]> = {}): Record<string, Row[]> => ({
    profiles: [
      profile(PERSON, "Ada"),
      profile(GUARDIAN, "Gus"),
      profile(CHILD, "Bea", { guardian_user_id: GUARDIAN, phone: null }),
    ],
    memberships: [],
    membership_plans: [],
    waivers: [
      {
        id: "w1",
        user_id: PERSON,
        first_name: "Ada",
        last_name: "Lovelace",
        signed_at: "2026-02-01T00:00:00+00:00",
        approval_status: "pending",
        approved_by: null,
        pdf_path: "w1.pdf",
        template_version: 3,
        signer_ip: "192.0.2.1",
        signer_meta: { ua: "x" },
      },
    ],
    session_checkins: [],
    interest_registrations: [],
    user_roles: [],
    calendar_events: [],
    code_of_conduct_acceptances: [
      { user_id: PERSON, version: 1, accepted_at: "2026-03-01T00:00:00Z", signature_name: "Ada L" },
    ],
    code_of_conduct_versions: [
      { version: 1, asks_reagreement: true, required_version: 1, is_current: true },
    ],
    ...over,
  });

  const EMAILS = [
    { user_id: PERSON, email: "ada@example.com", email_confirmed_at: "2026-01-02T00:00:00Z" },
    { user_id: GUARDIAN, email: "gus@example.com", email_confirmed_at: null },
  ];

  beforeEach(() => {
    vi.resetModules();
  });

  describe("list_users", () => {
    it("carries phone, verification and the code of conduct on every row", async () => {
      currentAdmin = fakeTables(tables(), { emails: EMAILS });
      const res = await post({ action: "list_users", params: {} });
      expect(res.status).toBe(200);
      const byId = new Map(
        (await res.json()).result.users.map((u: { user_id: string }) => [u.user_id, u]),
      );
      expect(byId.get(PERSON)).toMatchObject({
        phone: "0400 000 001",
        email_confirmed_at: "2026-01-02T00:00:00Z",
        code_of_conduct: {
          state: "signed",
          accepted_version: 1,
          accepted_at: "2026-03-01T00:00:00Z",
          signature_name: "Ada L",
        },
      });
      expect(byId.get(GUARDIAN)).toMatchObject({
        email_confirmed_at: null,
        code_of_conduct: { state: "unsigned", accepted_version: null },
      });
      // A child's address is the guardian's, so its verified state is too.
      expect(byId.get(CHILD)).toMatchObject({
        email: "gus@example.com",
        email_belongs_to: "Gus Lovelace",
        email_confirmed_at: null,
      });
    });

    // Signing again is unlimited, so the people on one page can hold more
    // acceptances than PostgREST returns in one response. Somebody whose only
    // agreement sits past that cap must still read as signed.
    it("reads every acceptance of the people it returns, past the response cap", async () => {
      const t = tables();
      const many = Array.from({ length: 1000 }, (_, i) => ({
        user_id: GUARDIAN,
        version: 1,
        accepted_at: `2026-04-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
        signature_name: "Gus L",
      }));
      t.code_of_conduct_acceptances = [...many, ...t.code_of_conduct_acceptances];
      currentAdmin = fakeTables(t, { emails: EMAILS });
      const res = await post({ action: "list_users", params: {} });
      const byId = new Map(
        (await res.json()).result.users.map((u: { user_id: string }) => [u.user_id, u]),
      );
      expect(byId.get(PERSON)).toMatchObject({
        code_of_conduct: { state: "signed", accepted_version: 1, signature_name: "Ada L" },
      });
      expect(byId.get(GUARDIAN)).toMatchObject({ code_of_conduct: { state: "signed" } });
    });

    it("refuses with db_error rather than reporting everybody as unsigned", async () => {
      currentAdmin = fakeTables(tables(), {
        emails: EMAILS,
        fail: { code_of_conduct_acceptances: "boom" },
      });
      const res = await post({ action: "list_users", params: {} });
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe("db_error");
    });
  });

  describe("get_user", () => {
    it("returns the person page's read, less the signer's IP and browser context", async () => {
      currentAdmin = fakeTables(tables(), { emails: EMAILS });
      const res = await post({ action: "get_user", params: { user_id: PERSON } });
      expect(res.status).toBe(200);
      const { result } = await res.json();
      expect(result.user).toMatchObject({
        name: "Ada Lovelace",
        email: "ada@example.com",
        email_belongs_to: null,
        email_confirmed_at: "2026-01-02T00:00:00Z",
      });
      expect(result.code_of_conduct).toMatchObject({ state: "signed", accepted_version: 1 });
      expect(result.waivers).toEqual([
        expect.objectContaining({ id: "w1", template_version: 3, has_pdf: true }),
      ]);
      expect(result.waivers[0]).not.toHaveProperty("signer_ip");
      expect(result.waivers[0]).not.toHaveProperty("signer_meta");
      expect(result.waivers[0].is_paper).toBe(false);
      expect(result).not.toHaveProperty("degraded");
    });

    it("captions a dependant's address as their guardian's", async () => {
      currentAdmin = fakeTables(tables(), { emails: EMAILS });
      const res = await post({ action: "get_user", params: { user_id: CHILD } });
      const { result } = await res.json();
      expect(result.user).toMatchObject({
        email: "gus@example.com",
        email_belongs_to: "Gus Lovelace",
      });
      expect(result.household.guardian).toEqual({ user_id: GUARDIAN, name: "Gus Lovelace" });
    });

    it("404s an id with no person record", async () => {
      currentAdmin = fakeTables(tables(), { emails: EMAILS });
      const res = await post({
        action: "get_user",
        params: { user_id: "99999999-9999-4999-8999-999999999999" },
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    });

    it.each(["memberships", "session_checkins", "waivers"])(
      "is a db_error, not an empty section, when the %s read fails",
      async (table) => {
        currentAdmin = fakeTables(tables(), { emails: EMAILS, fail: { [table]: "boom" } });
        const res = await post({ action: "get_user", params: { user_id: PERSON } });
        expect(res.status).toBe(500);
        expect((await res.json()).error.code).toBe("db_error");
      },
    );

    // The page shows these as "not signed yet" so a manager can still approve
    // somebody. An agent would act on that guess, so it gets the failure.
    it("is a db_error when the code of conduct could not be read", async () => {
      currentAdmin = fakeTables(tables(), {
        emails: EMAILS,
        fail: { code_of_conduct_acceptances: "boom" },
      });
      const res = await post({ action: "get_user", params: { user_id: PERSON } });
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe("db_error");
    });

    it("refuses a call naming the person as id rather than user_id", async () => {
      currentAdmin = {};
      const res = await post({ action: "get_user", params: { id: PERSON } });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_params");
    });
  });
});

describe("manager agent route: club settings", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fake `club_settings` store: reads by key, records every upsert. */
  function fakeSettings(values: Record<string, string>, opts: { readFails?: boolean } = {}) {
    const upserts: Record<string, unknown>[] = [];
    return {
      upserts,
      db: {
        from: (table: string) => {
          if (table !== "club_settings") throw new Error(`unexpected table ${table}`);
          return {
            select: () => ({
              eq: (_col: string, key: string) => ({
                maybeSingle: () =>
                  Promise.resolve(
                    opts.readFails
                      ? { data: null, error: { message: "connection reset" } }
                      : ok(key in values ? { value: values[key] } : null),
                  ),
              }),
            }),
            upsert: (row: Record<string, unknown>) => {
              upserts.push(row);
              return Promise.resolve({ error: null });
            },
          };
        },
      },
    };
  }

  it("reads the reply-to address and the bank account", async () => {
    currentAdmin = fakeSettings({ email_reply_to: "hello@example.com" }).db;
    const res = await post({ action: "get_club_settings", params: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({
      email_reply_to: "hello@example.com",
      payment_details: null,
    });
  });

  // "Could not read" must never come back as "nothing is set": a caller would
  // then set an address over one that is perfectly fine.
  it("answers a failed read with a retryable 503, not an empty answer", async () => {
    currentAdmin = fakeSettings({}, { readFails: true }).db;
    const res = await post({ action: "get_club_settings", params: {} });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("settings_unreadable");
  });

  // Both settings decide where members' replies and money go, so no token can
  // change them: the action does not exist, and nothing is written.
  it("has no way to change a club setting", async () => {
    const fake = fakeSettings({});
    currentAdmin = fake.db;
    const res = await post({
      action: "save_club_settings",
      params: { key: "email_reply_to", value: "someone@example.com" },
    });
    expect(res.status).toBe(400);
    expect(fake.upserts).toEqual([]);
  });
});

describe("manager agent route: site banner", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fake `club_settings` store holding (or failing to read) the banner. */
  function fakeBannerStore(stored: unknown, opts: { readFails?: boolean } = {}) {
    const upserts: Record<string, unknown>[] = [];
    return {
      upserts,
      db: {
        from: (table: string) => {
          if (table !== "club_settings") throw new Error(`unexpected table ${table}`);
          return {
            select: () => ({
              eq: (_col: string, key: string) => ({
                maybeSingle: () =>
                  Promise.resolve(
                    opts.readFails
                      ? { data: null, error: { message: "connection reset" } }
                      : ok(
                          key === "site_banner" && stored !== undefined
                            ? { value: JSON.stringify(stored) }
                            : null,
                        ),
                  ),
              }),
            }),
            upsert: (row: Record<string, unknown>) => {
              upserts.push(row);
              return Promise.resolve({ error: null });
            },
          };
        },
      },
    };
  }

  const LIVE = {
    enabled: true,
    message: "Free trials are paused for now.",
    link_label: "Register your interest",
    link_href: "/register-interest",
  };

  it("reads a banner nobody has set as off", async () => {
    currentAdmin = fakeBannerStore(undefined).db;
    const res = await post({ action: "get_site_banner", params: {} });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({
      banner: { enabled: false, message: "", link_label: "", link_href: "" },
    });
  });

  it("answers a failed read with a retryable 503, not an answer of off", async () => {
    currentAdmin = fakeBannerStore(undefined, { readFails: true }).db;
    const res = await post({ action: "get_site_banner", params: {} });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json()).error.code).toBe("settings_unreadable");
  });

  it("turns the banner off and keeps its message for next time", async () => {
    const fake = fakeBannerStore(LIVE);
    currentAdmin = fake.db;
    const res = await post({ action: "save_site_banner", params: { enabled: false } });
    expect(res.status).toBe(200);
    expect((await res.json()).result.banner).toEqual({ ...LIVE, enabled: false });
    expect(fake.upserts).toHaveLength(1);
    expect(fake.upserts[0].key).toBe("site_banner");
    expect(JSON.parse(fake.upserts[0].value as string)).toEqual({ ...LIVE, enabled: false });
  });

  it("refuses to switch on a banner with no message, and writes nothing", async () => {
    const fake = fakeBannerStore(undefined);
    currentAdmin = fake.db;
    const res = await post({ action: "save_site_banner", params: { enabled: true } });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("invalid_params");
    // Named as the param the caller sends, not the stored shape behind it.
    expect(error.issues[0].path).toBe("message");
    expect(fake.upserts).toEqual([]);
  });

  it("refuses a link that is not a page here or an https address", async () => {
    const fake = fakeBannerStore(LIVE);
    currentAdmin = fake.db;
    const res = await post({
      action: "save_site_banner",
      params: { link_href: "javascript:alert(1)" },
    });
    expect(res.status).toBe(400);
    expect(fake.upserts).toEqual([]);
  });

  // A leaked token must not be able to put a "pay here" link to another site
  // across the top of every page. That is the screen's job, signed in.
  it("refuses an outside link over the API, even a valid https one", async () => {
    const fake = fakeBannerStore(LIVE);
    currentAdmin = fake.db;
    const res = await post({
      action: "save_site_banner",
      params: { link_href: "https://example.com/pay" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.issues[0].path).toBe("link_href");
    expect(fake.upserts).toEqual([]);
  });

  it("can switch off a banner whose stored link goes to another site", async () => {
    const stored = { ...LIVE, link_href: "https://example.com/news" };
    const fake = fakeBannerStore(stored);
    currentAdmin = fake.db;
    const res = await post({ action: "save_site_banner", params: { enabled: false } });
    expect(res.status).toBe(200);
    expect((await res.json()).result.banner).toEqual({ ...stored, enabled: false });
  });

  // Otherwise a token could reword a manager's outside link into "pay here".
  it("will not reword or switch on a banner that links to another site", async () => {
    const stored = { ...LIVE, enabled: false, link_href: "https://example.com/news" };
    for (const params of [
      { message: "Membership fees are now paid here" },
      { link_label: "Pay now" },
      { enabled: true },
    ]) {
      const fake = fakeBannerStore(stored);
      currentAdmin = fake.db;
      const res = await post({ action: "save_site_banner", params });
      expect(res.status, JSON.stringify(params)).toBe(409);
      expect((await res.json()).error.code).toBe("outside_link");
      expect(fake.upserts).toEqual([]);
    }
  });

  it("can replace a stored outside link with a page on this site", async () => {
    const stored = { ...LIVE, link_href: "https://example.com/news" };
    const fake = fakeBannerStore(stored);
    currentAdmin = fake.db;
    const res = await post({ action: "save_site_banner", params: { link_href: "/classes" } });
    expect(res.status).toBe(200);
    expect((await res.json()).result.banner.link_href).toBe("/classes");
  });

  // Merging a change over a banner we could not read would save a guess.
  it("will not save over a banner it could not read", async () => {
    const fake = fakeBannerStore(undefined, { readFails: true });
    currentAdmin = fake.db;
    const res = await post({ action: "save_site_banner", params: { message: "Hello" } });
    expect(res.status).toBe(503);
    expect(fake.upserts).toEqual([]);
  });

  it("refuses an empty call rather than saving nothing", async () => {
    const fake = fakeBannerStore(LIVE);
    currentAdmin = fake.db;
    const res = await post({ action: "save_site_banner", params: {} });
    expect(res.status).toBe(400);
    expect(fake.upserts).toEqual([]);
  });
});

describe("manager agent route: resend_email", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an unknown kind before reading anything", async () => {
    currentAdmin = {};
    const res = await post({
      action: "resend_email",
      params: { kind: "password_reset", record_id: "7d4b6f0e-3a39-4a77-9d8b-2a1c1f0e5b11" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_params");
  });

  it("answers a record that is gone with 404 not_found", async () => {
    currentAdmin = {
      from: (table: string) => {
        if (table !== "item_invoices") throw new Error(`unexpected table ${table}`);
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ok(null)) }) }) };
      },
    };
    const res = await post({
      action: "resend_email",
      params: { kind: "item_invoice", record_id: "7d4b6f0e-3a39-4a77-9d8b-2a1c1f0e5b11" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  // A paid invoice has moved on: the caller has to change the request (resend
  // the receipt), so it is a 409 naming why, never a 5xx to retry.
  it("answers an invoice that has been paid with 409 paid", async () => {
    currentAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve(
                ok({
                  id: "7d4b6f0e-3a39-4a77-9d8b-2a1c1f0e5b11",
                  user_id: "22222222-2222-4222-8222-222222222222",
                  payment_reference: "INV0007",
                  lines: [],
                  total_cents: 8500,
                  paid_at: "2026-10-01T00:00:00Z",
                  cancelled_at: null,
                }),
              ),
          }),
        }),
      }),
    };
    const res = await post({
      action: "resend_email",
      params: { kind: "item_invoice", record_id: "7d4b6f0e-3a39-4a77-9d8b-2a1c1f0e5b11" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("paid");
  });
});

describe("manager agent route: the code of conduct", () => {
  const v = (version: number, over: Record<string, unknown> = {}) => ({
    id: `id-${version}`,
    version,
    title: "UTS Jitsu Code of Conduct",
    body_md: `# Version ${version}`,
    asks_reagreement: false,
    required_version: 1,
    is_current: false,
    first_published_at: "2026-10-01T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  });
  const LIVE = v(2, { is_current: true });

  beforeEach(() => {
    vi.resetModules();
    currentAdmin = {};
    for (const m of [
      listCodeOfConductVersionRowsMock,
      listCodeOfConductVersionFlagsMock,
      listCodeOfConductVersionSummariesMock,
      loadCodeOfConductVersionMock,
      saveCodeOfConductVersionMock,
      promoteCodeOfConductVersionMock,
      highestAcceptedVersionsMock,
    ])
      m.mockReset();
  });

  async function refusal(
    message: string,
    reason: "not_found" | "invalid" | "not_published",
    version?: number,
  ) {
    const { DocumentVersionError } = await import("@/lib/document-versions");
    return new DocumentVersionError(message, reason, version);
  }

  it("lists versions without their text, with what the club asks of people", async () => {
    // Version 3 was rolled away from: newer than the live one, but it was live.
    listCodeOfConductVersionSummariesMock.mockResolvedValue([
      v(3, { asks_reagreement: true, required_version: 3 }),
      LIVE,
      v(1, { asks_reagreement: true }),
    ]);
    const res = await post({ action: "list_code_of_conduct_versions", params: {} });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({ count: 3, live_version: 2, required_version: 1 });
    expect(result.versions[0]).toMatchObject({ version: 3, status: "Previous" });
    expect(result.versions[1]).toMatchObject({
      version: 2,
      status: "Live",
      asks_reagreement: false,
    });
    expect(result.versions[2]).toMatchObject({ status: "Previous", asks_reagreement: true });
    expect(result.versions[1]).not.toHaveProperty("body_md");
    // The listing never reads any version's text.
    expect(listCodeOfConductVersionRowsMock).not.toHaveBeenCalled();
  });

  it("says nobody can read it when nothing is live", async () => {
    loadCodeOfConductVersionMock.mockResolvedValue(null);
    const res = await post({ action: "get_code_of_conduct", params: {} });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/nobody can read it/);
  });

  it("carries the text over when only asking everybody to agree again", async () => {
    loadCodeOfConductVersionMock.mockResolvedValue(LIVE);
    listCodeOfConductVersionFlagsMock.mockResolvedValue([LIVE, v(1, { asks_reagreement: true })]);
    // Two people up to date on 1 and 2, one already behind (nothing below 1).
    highestAcceptedVersionsMock.mockResolvedValue([1, 2]);
    saveCodeOfConductVersionMock.mockResolvedValue({
      id: "id-3",
      version: 3,
      is_current: true,
      already_saved: false,
    });
    const res = await post({ action: "save_code_of_conduct", params: { asks_reagreement: true } });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({
      version: 3,
      based_on: 2,
      asks_reagreement: true,
      reprompted: 2,
    });
    expect(saveCodeOfConductVersionMock.mock.calls[0][1]).toMatchObject({
      title: LIVE.title,
      body_md: LIVE.body_md,
      asks_reagreement: true,
    });
    // The save works from the flags this count read, not a second read.
    expect(saveCodeOfConductVersionMock.mock.calls[0][3]).toEqual([
      LIVE,
      v(1, { asks_reagreement: true }),
    ]);
  });

  // A correction must not ask anybody anything, and must not spend a read on
  // counting people it cannot affect.
  it("re-prompts nobody for a correction", async () => {
    listCodeOfConductVersionFlagsMock.mockResolvedValue([LIVE, v(1, { asks_reagreement: true })]);
    highestAcceptedVersionsMock.mockResolvedValue([1, 2]);
    saveCodeOfConductVersionMock.mockResolvedValue({
      id: "id-3",
      version: 3,
      is_current: true,
      already_saved: false,
    });
    const res = await post({
      action: "save_code_of_conduct",
      params: { title: "Code", body_md: "# Fixed" },
    });
    const { result } = await res.json();
    expect(result).toMatchObject({ asks_reagreement: false, reprompted: 0, based_on: null });
  });

  // With nothing live, a correction inherits the newest version's requirement,
  // which can put people out of date without anybody asking. The reply has to
  // say so rather than report the 0 a correction normally means.
  it("counts who a correction re-prompts when nothing was live", async () => {
    listCodeOfConductVersionFlagsMock.mockResolvedValue([
      v(2, { asks_reagreement: true, required_version: 2 }),
      v(1, { asks_reagreement: true }),
    ]);
    highestAcceptedVersionsMock.mockResolvedValue([1, 1, 2]);
    saveCodeOfConductVersionMock.mockResolvedValue({
      id: "id-3",
      version: 3,
      is_current: true,
      already_saved: false,
    });
    const res = await post({
      action: "save_code_of_conduct",
      params: { title: "Code", body_md: "# Fixed" },
    });
    expect((await res.json()).result).toMatchObject({ asks_reagreement: false, reprompted: 2 });
  });

  it("refuses a save that changes nothing", async () => {
    const res = await post({ action: "save_code_of_conduct", params: {} });
    expect(res.status).toBe(400);
    expect(saveCodeOfConductVersionMock).not.toHaveBeenCalled();
  });

  it("reports a replayed save as already saved, re-prompting nobody new", async () => {
    loadCodeOfConductVersionMock.mockResolvedValue(LIVE);
    listCodeOfConductVersionFlagsMock.mockResolvedValue([LIVE]);
    highestAcceptedVersionsMock.mockResolvedValue([2]);
    saveCodeOfConductVersionMock.mockResolvedValue({
      id: "id-3",
      version: 3,
      is_current: true,
      already_saved: true,
    });
    const res = await post({
      action: "save_code_of_conduct",
      params: {
        asks_reagreement: true,
        client_submission_id: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect((await res.json()).result).toMatchObject({ already_saved: true, reprompted: 0 });
  });

  it("reports a version written but not made live as a retryable 503", async () => {
    listCodeOfConductVersionFlagsMock.mockResolvedValue([LIVE]);
    highestAcceptedVersionsMock.mockResolvedValue([]);
    saveCodeOfConductVersionMock.mockRejectedValue(
      await refusal("Someone else changed it.", "not_published", 3),
    );
    const res = await post({
      action: "save_code_of_conduct",
      params: { title: "Code", body_md: "# Fixed" },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = await res.json();
    expect(body.error.code).toBe("code_of_conduct_not_published");
    expect(body.error.details).toEqual({ version: 3, published: false });
  });

  it("rolls back, saying who is out of date afterwards", async () => {
    // Version 2 did not ask, so it requires what version 1 did. Rolling back
    // from version 3, which asked, puts nobody out of date.
    loadCodeOfConductVersionMock.mockResolvedValue(v(2, { required_version: 1 }));
    listCodeOfConductVersionFlagsMock.mockResolvedValue([
      v(1, { asks_reagreement: true }),
      v(2, { required_version: 1 }),
      v(3, { asks_reagreement: true, required_version: 3, is_current: true }),
    ]);
    highestAcceptedVersionsMock.mockResolvedValue([1, 3]);
    promoteCodeOfConductVersionMock.mockResolvedValue({ version: 2 });
    const res = await post({ action: "publish_code_of_conduct", params: { version: 2 } });
    expect((await res.json()).result).toEqual({
      version: 2,
      published: true,
      required_version: 1,
      reprompted: 0,
    });
  });

  // The editor tells a manager how many people a publish re-prompts before the
  // click; the API reports the same number, so an agent can say it too.
  it("says how many people a publish asks to agree again", async () => {
    loadCodeOfConductVersionMock.mockResolvedValue(
      v(3, { asks_reagreement: true, required_version: 3 }),
    );
    listCodeOfConductVersionFlagsMock.mockResolvedValue([
      v(1, { asks_reagreement: true }),
      LIVE,
      v(3, { asks_reagreement: true, required_version: 3 }),
    ]);
    highestAcceptedVersionsMock.mockResolvedValue([1, 2, 3]);
    promoteCodeOfConductVersionMock.mockResolvedValue({ version: 3 });
    const res = await post({ action: "publish_code_of_conduct", params: { version: 3 } });
    expect((await res.json()).result).toMatchObject({ published: true, reprompted: 2 });
  });

  it("publishes nothing when it cannot count who the publish re-prompts", async () => {
    loadCodeOfConductVersionMock.mockResolvedValue(v(3));
    listCodeOfConductVersionFlagsMock.mockResolvedValue([LIVE, v(3)]);
    highestAcceptedVersionsMock.mockRejectedValue(new Error("connection reset"));
    const res = await post({ action: "publish_code_of_conduct", params: { version: 3 } });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("db_error");
    expect(promoteCodeOfConductVersionMock).not.toHaveBeenCalled();
  });

  it("changes nothing, and says so, for the version already live", async () => {
    loadCodeOfConductVersionMock.mockResolvedValue(LIVE);
    const res = await post({ action: "publish_code_of_conduct", params: { version: 2 } });
    expect((await res.json()).result).toEqual({ version: 2, published: false });
    expect(promoteCodeOfConductVersionMock).not.toHaveBeenCalled();
  });

  it("404s a version that does not exist", async () => {
    loadCodeOfConductVersionMock.mockResolvedValue(null);
    const res = await post({ action: "publish_code_of_conduct", params: { version: 9 } });
    expect(res.status).toBe(404);
  });
});

describe("manager agent route: the blog", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyNewBlogPostMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const DRAFT_ID = "5b0f3c1e-9a8d-4c2b-8e7f-1a2b3c4d5e6f";
  const LIVE_ID = "6c1a4d2f-0b9e-4d3c-9f80-2b3c4d5e6f70";

  type Row = Record<string, unknown>;

  /**
   * An in-memory `blog_posts` table and `blog-media` bucket, evaluating the
   * filters each chain applies rather than ignoring them, so a save that wrote
   * the wrong row or a slug check that matched nothing would show.
   */
  function fakeBlog(
    seed: Row[],
    opts: {
      afterFirstRead?: (rows: Row[]) => void;
      /** Another upload lands at the same path just before the first one does. */
      racedBy?: boolean;
    } = {},
  ) {
    const rows = seed.map((r) => ({ ...r }));
    let reads = 0;
    let raced = false;
    const uploads: { path: string; type: string; size: number }[] = [];
    const removed: string[] = [];
    const query = (op: "select" | "update" | "delete", patch?: Row) => {
      const filters: ((r: Row) => boolean)[] = [];
      const matching = () => rows.filter((r) => filters.every((f) => f(r)));
      const run = () => {
        const hit = matching();
        if (op === "update") for (const r of hit) Object.assign(r, patch);
        if (op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return hit.map((r) => ({ ...r }));
      };
      const c: Record<string, unknown> = {
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), c),
        neq: (col: string, val: unknown) => (filters.push((r) => r[col] !== val), c),
        ilike: (col: string, pattern: string) => {
          const re = new RegExp(
            `^${pattern
              .split("%")
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join(".*")}$`,
            "i",
          );
          filters.push((r) => re.test(String(r[col])));
          return c;
        },
        order: () => c,
        limit: () => c,
        select: () => c,
        maybeSingle: () => {
          const hit = run()[0] ?? null;
          if (reads++ === 0) opts.afterFirstRead?.(rows);
          return Promise.resolve(ok(hit));
        },
        then: (resolve: (r: unknown) => void) => resolve(ok(run())),
      };
      return c;
    };
    return {
      rows,
      uploads,
      removed,
      db: {
        from: (table: string) => {
          if (table !== "blog_posts") throw new Error(`unexpected table ${table}`);
          return {
            select: () => query("select"),
            update: (patch: Row) => query("update", patch),
            delete: () => query("delete"),
            insert: (row: Row) => ({
              select: () => ({
                single: () => {
                  const id = "7d2b5e30-1caf-4e4d-a091-3c4d5e6f7081";
                  rows.push({ id, created_at: "2026-10-24T00:00:00Z", updated_at: "now", ...row });
                  return Promise.resolve(ok({ id, slug: row.slug }));
                },
              }),
            }),
          };
        },
        storage: {
          from: (bucket: string) => {
            if (bucket !== "blog-media") throw new Error(`unexpected bucket ${bucket}`);
            return {
              upload: (path: string, bytes: Uint8Array, up: { contentType: string }) => {
                if (opts.racedBy && !raced) {
                  raced = true;
                  uploads.push({ path, type: up.contentType, size: 1 });
                }
                // As the bucket does with upsert off: a path is written once.
                if (uploads.some((u) => u.path === path)) {
                  return Promise.resolve({ error: { message: "The resource already exists" } });
                }
                uploads.push({ path, type: up.contentType, size: bytes.byteLength });
                return Promise.resolve({ error: null });
              },
              list: (folder: string, opts: { search: string }) =>
                Promise.resolve(
                  ok(
                    uploads
                      .filter((u) => u.path.startsWith(`${folder}/`))
                      .map((u) => ({ name: u.path.slice(folder.length + 1) }))
                      .filter((o) => o.name.includes(opts.search)),
                  ),
                ),
              getPublicUrl: (path: string) => ({
                data: { publicUrl: `https://cdn.example.com/blog-media/${path}` },
              }),
              remove: (paths: string[]) => {
                removed.push(...paths);
                return Promise.resolve({ error: null });
              },
            };
          },
        },
      },
    };
  }

  const DRAFT = {
    id: DRAFT_ID,
    slug: "2026-10-20-grading-day",
    title: "Grading day",
    excerpt: "Who is grading, and when.",
    body_md: "Grading is on Saturday.",
    cover_image_path: "drafts/cover.jpg",
    status: "draft",
    published_at: null,
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  };
  const LIVE = {
    ...DRAFT,
    id: LIVE_ID,
    slug: "2026-09-01-welcome",
    title: "Welcome",
    status: "published",
    published_at: "2026-09-01T00:00:00Z",
  };

  // The reason the action carries omitted fields over: publishing a draft is
  // one field, and it must not wipe the cover or the excerpt it was written with.
  it("publishes a draft from status alone, keeping everything else, and announces it once", async () => {
    const fake = fakeBlog([DRAFT]);
    currentAdmin = fake.db;
    const res = await post({
      action: "save_blog_post",
      params: { id: DRAFT_ID, status: "published" },
    });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({
      created: false,
      announced: true,
      post: {
        status: "published",
        title: "Grading day",
        excerpt: "Who is grading, and when.",
        cover_image_path: "drafts/cover.jpg",
        url: "https://utsjitsu.com.au/blog/2026-10-20-grading-day",
        edit_url: `https://utsjitsu.com.au/manager/blog/${DRAFT_ID}`,
      },
    });
    expect(fake.rows[0].body_md).toBe("Grading is on Saturday.");
    expect(fake.rows[0].published_at).toEqual(expect.any(String));
    expect(notifyNewBlogPostMock).toHaveBeenCalledTimes(1);
    expect(notifyNewBlogPostMock.mock.calls[0][1]).toMatchObject({
      postId: DRAFT_ID,
      actorId: TOKEN_OWNER,
    });
  });

  // The failure this guards: the shared writer reads an absent status as
  // draft, so a typo fix sent straight through would take the post down.
  it("edits a live post's body without unpublishing it or announcing it again", async () => {
    const fake = fakeBlog([LIVE]);
    currentAdmin = fake.db;
    const res = await post({
      action: "save_blog_post",
      params: { id: LIVE_ID, body_md: "Welcome to the club." },
    });
    expect(res.status).toBe(200);
    expect(fake.rows[0]).toMatchObject({
      status: "published",
      published_at: "2026-09-01T00:00:00Z",
      body_md: "Welcome to the club.",
      cover_image_path: "drafts/cover.jpg",
      slug: "2026-09-01-welcome",
    });
    expect((await res.json()).result.announced).toBe(false);
    expect(notifyNewBlogPostMock).not.toHaveBeenCalled();
  });

  // Members were told the first time. Republishing calls the announcement
  // again, but the unique index swallows it, so it must not be reported as one.
  it("does not report a republish as announcing the post again", async () => {
    const fake = fakeBlog([{ ...LIVE, status: "draft" }]);
    currentAdmin = fake.db;
    const res = await post({
      action: "save_blog_post",
      params: { id: LIVE_ID, status: "published" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({
      announced: false,
      post: { status: "published", published_at: "2026-09-01T00:00:00Z" },
    });
  });

  it("creates a new post as a draft with no public address unless told otherwise", async () => {
    const fake = fakeBlog([]);
    currentAdmin = fake.db;
    const res = await post({
      action: "save_blog_post",
      params: { title: "Summer timetable", body_md: "Classes run all summer." },
    });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({
      created: true,
      announced: false,
      post: { status: "draft", url: null },
    });
    expect(result.post.slug).toMatch(/^\d{4}-\d{2}-\d{2}-summer-timetable$/);
    expect(result.post.excerpt).toBe("Classes run all summer.");
    expect(fake.rows[0].author_id).toBe(TOKEN_OWNER);
    expect(notifyNewBlogPostMock).not.toHaveBeenCalled();
  });

  // A create the agent never heard back from gets retried. Suffixing the
  // address the way the editor does would file the post twice and announce it
  // twice; refusing names the post the first attempt made.
  it("refuses a create whose address is taken, naming the post that has it", async () => {
    const fake = fakeBlog([DRAFT]);
    currentAdmin = fake.db;
    const res = await post({
      action: "save_blog_post",
      params: { title: "Grading day", body_md: "Again.", slug: DRAFT.slug, status: "published" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      code: "slug_taken",
      details: { id: DRAFT_ID, slug: DRAFT.slug },
    });
    expect(fake.rows).toHaveLength(1);
    expect(notifyNewBlogPostMock).not.toHaveBeenCalled();
  });

  // The agent writes back the fields it did not send, from what it read. A
  // manager's save landing in between must not be quietly undone.
  it("refuses an edit when the post was saved after it was read, writing nothing", async () => {
    const fake = fakeBlog([LIVE], {
      afterFirstRead: (rows) => {
        rows[0].body_md = "The manager's new body.";
        rows[0].updated_at = "2026-10-24T09:00:00Z";
      },
    });
    currentAdmin = fake.db;
    const res = await post({ action: "save_blog_post", params: { id: LIVE_ID, title: "Hello" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("post_changed");
    expect(fake.rows[0]).toMatchObject({ title: "Welcome", body_md: "The manager's new body." });
  });

  it("refuses a new post with no body, writing nothing", async () => {
    const fake = fakeBlog([]);
    currentAdmin = fake.db;
    const res = await post({ action: "save_blog_post", params: { title: "Half a post" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_params");
    expect(fake.rows).toEqual([]);
  });

  it("reports a change to a post that is not there as not_found", async () => {
    currentAdmin = fakeBlog([]).db;
    const res = await post({ action: "save_blog_post", params: { id: DRAFT_ID, title: "x" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("reads a draft by its slug, body included", async () => {
    currentAdmin = fakeBlog([DRAFT, LIVE]).db;
    const res = await post({ action: "get_blog_post", params: { slug: DRAFT.slug } });
    expect(res.status).toBe(200);
    expect((await res.json()).result.post).toMatchObject({
      id: DRAFT_ID,
      body_md: "Grading is on Saturday.",
      cover_image_url: "https://cdn.example.com/blog-media/drafts/cover.jpg",
      url: null,
    });
  });

  it("lists drafts and live posts alike, with the public address only on the live one", async () => {
    currentAdmin = fakeBlog([DRAFT, LIVE]).db;
    const res = await post({ action: "list_blog_posts", params: {} });
    const { result } = await res.json();
    expect(result.count).toBe(2);
    expect(result.posts.map((p: { url: string | null }) => p.url)).toEqual([
      null,
      "https://utsjitsu.com.au/blog/2026-09-01-welcome",
    ]);
    expect(result.posts[0]).not.toHaveProperty("body_md");
  });

  it("deletes a post and its cover, and reports one that is not there as not_found", async () => {
    const fake = fakeBlog([DRAFT]);
    currentAdmin = fake.db;
    const res = await post({ action: "delete_blog_post", params: { id: DRAFT_ID } });
    expect(res.status).toBe(200);
    expect(fake.rows).toEqual([]);
    expect(fake.removed).toEqual(["drafts/cover.jpg"]);

    const again = await post({ action: "delete_blog_post", params: { id: DRAFT_ID } });
    expect(again.status).toBe(404);
  });

  // The agent can give two posts the same stored picture. Deleting one must
  // not take the picture away from the other.
  it("keeps a cover another post still shows", async () => {
    const fake = fakeBlog([
      DRAFT,
      { ...LIVE, cover_image_path: null, body_md: "![x](https://cdn/blog-media/drafts/cover.jpg)" },
    ]);
    currentAdmin = fake.db;
    const res = await post({ action: "delete_blog_post", params: { id: DRAFT_ID } });
    expect(res.status).toBe(200);
    expect(fake.rows.map((r) => r.id)).toEqual([LIVE_ID]);
    expect(fake.removed).toEqual([]);
  });

  // A one-pixel PNG: the smallest real image there is.
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("stores a base64 image under the type its bytes say, with markdown to paste", async () => {
    const fake = fakeBlog([]);
    currentAdmin = fake.db;
    const res = await post({
      action: "upload_blog_image",
      params: { data: PNG_BASE64, name: "mat", alt: "The mats laid out" },
    });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(fake.uploads).toEqual([
      { path: expect.stringMatching(/^drafts\/.+-mat\.png$/), type: "image/png", size: 70 },
    ]);
    expect(result).toMatchObject({ type: "image/png", path: fake.uploads[0].path });
    expect(result.markdown).toBe(`![The mats laid out](${result.url})`);
  });

  it("refuses bytes that are not an image, storing nothing", async () => {
    const fake = fakeBlog([]);
    currentAdmin = fake.db;
    const res = await post({
      action: "upload_blog_image",
      params: { data: btoa("<html>not a picture</html>"), name: "photo.png" },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("image_rejected");
    expect(fake.uploads).toEqual([]);
  });

  it("downloads an image from a public https address", async () => {
    const fake = fakeBlog([]);
    currentAdmin = fake.db;
    const png = Uint8Array.from(atob(PNG_BASE64), (ch) => ch.charCodeAt(0));
    const fetchMock = vi.fn().mockResolvedValue(new Response(png, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await post({
      action: "upload_blog_image",
      params: { url: "https://images.example.com/photos/belt.png" },
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fake.uploads[0].path).toMatch(/-belt\.png$/);
  });

  // The route for an assistant that holds the file but can only type: ask for
  // a link over the API, then send the bytes to it.
  describe("upload links", () => {
    const png = () => Uint8Array.from(atob(PNG_BASE64), (ch) => ch.charCodeAt(0));

    async function startUpload(params: Record<string, unknown> = {}) {
      const res = await post({ action: "start_blog_image_upload", params });
      expect(res.status).toBe(200);
      return (await res.json()).result as {
        upload_url: string;
        token: string;
        expires_at: string;
        command: string;
      };
    }

    async function send(token: string | null, body: BodyInit | null = png()) {
      const { Route } = await import("./blog-image");
      const h = (Route as unknown as { options: { server: { handlers: RouteHandlers } } }).options
        .server.handlers;
      return h.POST({
        request: new Request("http://localhost/api/manager/blog-image", {
          method: "POST",
          headers: token ? { authorization: `Bearer ${token}` } : {},
          body,
        }),
      });
    }

    beforeEach(() => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
      stillManager = true;
    });
    afterEach(() => {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      stillManager = true;
      vi.useRealTimers();
    });

    it("hands out a link that works for an hour, to the stack that was asked", async () => {
      currentAdmin = fakeBlog([]).db;
      const before = Date.now();
      const link = await startUpload({ alt: "The mats" });
      // These requests arrive on localhost: a local stack's tickets only
      // verify on itself, so it hands out its own address.
      expect(link.upload_url).toBe("http://localhost/api/manager/blog-image");
      expect(link.command).toContain(link.token);
      expect(link.command).toContain('--data-binary "@$IMAGE_FILE"');
      const minutes = (Date.parse(link.expires_at) - before) / 60_000;
      expect(minutes).toBeGreaterThan(59.9);
      expect(minutes).toBeLessThan(60.1);
    });

    // Anywhere else (a preview, the lovable.app address, an old domain), the
    // live site: the one host that does not redirect the bearer header away.
    it("sends every other host's link to the live site", async () => {
      currentAdmin = fakeBlog([]).db;
      const res = await (
        await handlers()
      ).POST({
        request: new Request("https://preview.example.lovable.app/api/manager/agent", {
          method: "POST",
          headers: { authorization: `Bearer ${MINTED_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "start_blog_image_upload", params: {} }),
        }),
      });
      const { result } = await res.json();
      expect(result.upload_url).toBe("https://utsjitsu.com.au/api/manager/blog-image");
    });

    it("stores the image sent to it, with the same answer upload_blog_image gives", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      const link = await startUpload({ post_id: DRAFT_ID, name: "mat", alt: "The mats laid out" });
      const res = await send(link.token);
      expect(res.status).toBe(200);
      const { result, version } = await res.json();
      expect(version).toBe(AGENT_MANIFEST.version);
      expect(fake.uploads).toEqual([
        {
          path: expect.stringMatching(new RegExp(`^${DRAFT_ID}/.+-mat\\.png$`)),
          type: "image/png",
          size: 70,
        },
      ]);
      expect(result).toMatchObject({ type: "image/png", bytes: 70, path: fake.uploads[0].path });
      expect(result.markdown).toBe(`![The mats laid out](${result.url})`);
    });

    // A retry whose answer was lost must not store a second copy, and must be
    // told where the first one went, so it can carry on with nothing more.
    it("works once, and tells a second upload what the first stored", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      const link = await startUpload({ alt: "Belt" });
      const first = await (await send(link.token)).json();
      const again = await send(link.token);
      expect(again.status).toBe(409);
      const { error } = await again.json();
      expect(error.code).toBe("already_uploaded");
      expect(error.details).toMatchObject({
        path: first.result.path,
        url: first.result.url,
        markdown: first.result.markdown,
      });
      expect(fake.uploads).toHaveLength(1);
    });

    // Two uploads on one link, both past the "already used?" look before
    // either stored: the bucket refuses the second, and it must hear what the
    // first stored rather than a database error.
    it("tells the loser of a race on one link what the winner stored", async () => {
      const fake = fakeBlog([], { racedBy: true });
      currentAdmin = fake.db;
      const link = await startUpload();
      const res = await send(link.token);
      expect(res.status).toBe(409);
      const { error } = await res.json();
      expect(error.code).toBe("already_uploaded");
      expect(error.details.path).toBe(fake.uploads[0].path);
      expect(fake.uploads).toHaveLength(1);
    });

    // Over MCP no front door says what address was asked. On a local stack
    // the only link left is the live site's, which its ticket cannot pass.
    it("gives no link over MCP from a local stack, and the live one otherwise", async () => {
      currentAdmin = fakeBlog([]).db;
      const { dispatch } = await import("@/lib/manager-agent-actions");
      const before = process.env.SUPABASE_URL;
      try {
        process.env.SUPABASE_URL = "http://127.0.0.1:54321";
        await expect(dispatch("start_blog_image_upload", {}, TOKEN_OWNER)).rejects.toMatchObject({
          code: "upload_links_unavailable",
        });
        process.env.SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
        const link = (await dispatch("start_blog_image_upload", {}, TOKEN_OWNER)) as {
          upload_url: string;
        };
        expect(link.upload_url).toBe("https://utsjitsu.com.au/api/manager/blog-image");
      } finally {
        if (before === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = before;
      }
    });

    it("gives each link its own image", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      expect((await send((await startUpload()).token)).status).toBe(200);
      expect((await send((await startUpload()).token)).status).toBe(200);
      expect(fake.uploads).toHaveLength(2);
    });

    it("refuses an expired link, storing nothing", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      const link = await startUpload();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(link.expires_at) + 1000);
      const res = await send(link.token);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("link_expired");
      expect(fake.uploads).toEqual([]);
    });

    // A retry whose answer was lost, arriving after the hour: it must learn
    // what its first attempt stored, not be sent off to upload a second copy.
    it("still tells a late retry what the link stored", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      const link = await startUpload();
      const first = await (await send(link.token)).json();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(link.expires_at) + 1000);
      const late = await send(link.token);
      expect(late.status).toBe(409);
      expect((await late.json()).error.details.path).toBe(first.result.path);
      expect(fake.uploads).toHaveLength(1);
    });

    // The link is not a manager credential, and a manager credential is not a
    // link: neither works at the other's door.
    it("takes only an upload link, never a manager API token", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      expect((await send(MINTED_TOKEN)).status).toBe(401);
      expect((await send(null)).status).toBe(401);
      const link = await startUpload();
      expect((await post({ action: "list_blog_posts", params: {} }, link.token)).status).toBe(401);
      expect(fake.uploads).toEqual([]);
    });

    it("stops working when whoever asked for it is no longer a manager", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      const link = await startUpload();
      stillManager = false;
      const res = await send(link.token);
      expect(res.status).toBe(403);
      expect(fake.uploads).toEqual([]);
    });

    it("refuses what is not an image, and leaves the link usable", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      const link = await startUpload();
      const wrong = await send(link.token, new TextEncoder().encode("<html>not a picture</html>"));
      expect(wrong.status).toBe(422);
      expect((await wrong.json()).error.code).toBe("image_rejected");
      const empty = await send(link.token, null);
      expect(empty.status).toBe(422);
      expect(fake.uploads).toEqual([]);
      expect((await send(link.token)).status).toBe(200);
    });

    it("refuses an image over 8 MB without storing it", async () => {
      const fake = fakeBlog([]);
      currentAdmin = fake.db;
      const link = await startUpload();
      const big = new Uint8Array(8 * 1024 * 1024 + 1);
      big.set(png());
      const res = await send(link.token, big);
      expect(res.status).toBe(422);
      expect(fake.uploads).toEqual([]);
    });

    it("answers anything but POST with 405", async () => {
      const { Route } = await import("./blog-image");
      const h = (Route as unknown as { options: { server: { handlers: RouteHandlers } } }).options
        .server.handlers;
      const res = await h.GET({ request: new Request("http://localhost/api/manager/blog-image") });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    });
  });

  it("will not fetch an address that is not public https", async () => {
    const fake = fakeBlog([]);
    currentAdmin = fake.db;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await post({
      action: "upload_blog_image",
      params: { url: "http://169.254.169.254/latest/meta-data" },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("image_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.uploads).toEqual([]);
  });
});

describe("save_membership_plan with announce", () => {
  const PLAN_ID = "55555555-5555-4555-8555-555555555555";
  const ANNOUNCEMENT_ID = "66666666-6666-4666-8666-666666666666";
  const PARAMS = {
    id: PLAN_ID,
    code: "2027-s1",
    name: "Semester 1 2027",
    kind: "period",
    public_price_cents: 44500,
    student_price_cents: 24500,
    duration_days: null,
    session_credits: null,
    is_active: true,
    sort_order: 1,
    starts_on: "2027-03-01",
    ends_on: "2027-06-30",
  };

  /** Records every plan write, so a refusal can be shown to have written nothing. */
  function fakePlans() {
    const writes: unknown[] = [];
    currentAdmin = {
      from: (table: string) => {
        if (table !== "membership_plans") throw new Error(`unexpected table ${table}`);
        return {
          update: (values: unknown) => {
            writes.push(values);
            return { eq: () => Promise.resolve(ok(null)) };
          },
        };
      },
    };
    return writes;
  }

  beforeEach(() => {
    vi.resetModules();
    announceMembershipPlanMock.mockReset();
  });

  it("saves without emailing anybody when announce is not asked for", async () => {
    const writes = fakePlans();
    const res = await post({ action: "save_membership_plan", params: PARAMS });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ id: PLAN_ID, announcement: null });
    expect(writes).toHaveLength(1);
    expect(announceMembershipPlanMock).not.toHaveBeenCalled();
  });

  // Without an id a retried call would email the whole club twice, so it is
  // refused before the plan is even saved.
  it("refuses announce without an announcement_id, before saving anything", async () => {
    const writes = fakePlans();
    const res = await post({
      action: "save_membership_plan",
      params: { ...PARAMS, announce: true },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.issues[0].path).toBe("announcement_id");
    expect(writes).toHaveLength(0);
    expect(announceMembershipPlanMock).not.toHaveBeenCalled();
  });

  it("saves, then announces as the token's owner, and reports the send", async () => {
    fakePlans();
    announceMembershipPlanMock.mockResolvedValue({
      plan_id: PLAN_ID,
      announcement_id: ANNOUNCEMENT_ID,
      recipients: 84,
      emailed: 84,
      pending: 0,
      announced_at: "2026-11-03T01:00:00.000Z",
    });
    const res = await post({
      action: "save_membership_plan",
      params: { ...PARAMS, announce: true, announcement_id: ANNOUNCEMENT_ID },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({
      id: PLAN_ID,
      announcement: { recipients: 84, pending: 0, announcement_id: ANNOUNCEMENT_ID },
    });
    expect(announceMembershipPlanMock.mock.calls[0][1]).toEqual({
      planId: PLAN_ID,
      announcementId: ANNOUNCEMENT_ID,
      actorId: TOKEN_OWNER,
    });
  });

  // An update naming an id that matches no plan writes nothing and does not
  // fail, so the announcement is where it surfaces: as a 404, never as "saved".
  it("answers an id that matches no plan with 404, not 'the plan was saved'", async () => {
    fakePlans();
    const { PlanAnnouncementError } = await import("@/lib/plan-announcement.server");
    announceMembershipPlanMock.mockRejectedValue(
      new PlanAnnouncementError("plan_not_found", "That plan does not exist."),
    );
    const res = await post({
      action: "save_membership_plan",
      params: { ...PARAMS, announce: true, announcement_id: ANNOUNCEMENT_ID },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("says the plan is saved when only the email failed, so the caller retries the email", async () => {
    fakePlans();
    announceMembershipPlanMock.mockRejectedValue(new Error("provider down"));
    const res = await post({
      action: "save_membership_plan",
      params: { ...PARAMS, announce: true, announcement_id: ANNOUNCEMENT_ID },
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("announcement_failed");
    expect(body.error.details).toEqual({ id: PLAN_ID, announcement_id: ANNOUNCEMENT_ID });
    expect(body.error.message).toMatch(/same announcement_id/);
    // A plan this call created has to be retried by id, or it is created again.
    expect(body.error.message).toMatch(/error\.details\.id/);
  });
});

// ---- The calendar ----
//
// The shared functions' own rules (what counts as already on the calendar,
// which dates a weekly run holds, what a delete refuses) are pinned in
// calendar.functions.test.ts. What the route owns, and what is pinned here, is
// what an agent meets on the way in and on the way out: the club-time reading
// and the gym default it applies before the screen's own schema, the params it
// refuses rather than ignores, and the status and envelope each refusal becomes,
// details included, because those are what an agent branches on.
describe("manager agent route: the calendar", () => {
  const ONE_OFF = "a1111111-1111-4111-8111-111111111111";
  const QUIET_ONE_OFF = "a2222222-2222-4222-8222-222222222222";
  const WEEKLY_DATE = "a3333333-3333-4333-8333-333333333333";
  const SERIES = "a4444444-4444-4444-8444-444444444444";
  const MISSING = "a5555555-5555-4555-8555-555555555555";
  const DB_TEXT = 'relation "public.calendar_events" does not exist';

  type Row = Record<string, unknown>;
  type Write = { op: "insert" | "delete"; table: string; values: unknown };

  /** A one-off date in Sydney daylight time: Thursday 3 December, 6pm to 7:30pm. */
  const event = (id: string, over: Row = {}): Row => ({
    id,
    series_id: null,
    title: "Grading",
    description: null,
    instructor_name: null,
    location: null,
    starts_at: "2026-12-03T07:00:00.000Z",
    ends_at: "2026-12-03T08:30:00.000Z",
    status: "scheduled",
    visibility: "public",
    invite_only: false,
    ...over,
  });

  /** The way a manager says it, in club time, with no location. */
  const ONE_OFF_PARAMS = {
    title: "Grading",
    repeat: { type: "never", starts_at: "2026-12-03T18:00", ends_at: "2026-12-03T19:30" },
  };

  /**
   * In-memory calendar tables. It evaluates `eq`, `in`, `gte`, `lte`, `not ...
   * is null` and the `count` + `head` select, so a refusal comes from the row
   * the request names: a fake that answered every read with the same row would
   * pass the weekly-date case with the one-off's id, and count another date's
   * check-ins against this one. Order and limit are no-ops. Every table reached
   * goes into `touched` and every insert and delete into `writes`, so a refusal
   * can be shown to have read, or written, nothing. A new row's id is
   * `<table>#<n>`, so a test can tell a weekly entry's id from its dates'.
   */
  function fakeCalendar(
    seed: Record<string, Row[]> = {},
    opts: { fail?: Record<string, string> } = {},
  ) {
    const tables: Record<string, Row[]> = {};
    for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
    const touched: string[] = [];
    const writes: Write[] = [];
    const made = new Map<string, number>();
    return {
      tables,
      touched,
      writes,
      db: {
        from: (table: string) => {
          touched.push(table);
          const filters: ((r: Row) => boolean)[] = [];
          let head = false;
          let deleting = false;
          let inserted: Row[] | null = null;
          const result = () => {
            const fail = opts.fail?.[table];
            if (fail) return { data: null, count: null, error: { message: fail } };
            if (inserted) return { data: inserted, count: inserted.length, error: null };
            const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
            if (deleting) {
              writes.push({ op: "delete", table, values: rows.map((r) => r.id) });
              tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r));
              return { data: null, count: null, error: null };
            }
            return { data: head ? null : rows, count: rows.length, error: null };
          };
          const one = () => {
            const r = result();
            return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
          };
          const b = {
            select: (_cols?: string, o?: { head?: boolean }) => {
              if (o?.head) head = true;
              return b;
            },
            insert: (values: Row | Row[]) => {
              writes.push({ op: "insert", table, values });
              // What the database fills in: an id, and for a date, that it is on.
              inserted = (Array.isArray(values) ? values : [values]).map((v) => {
                const n = (made.get(table) ?? 0) + 1;
                made.set(table, n);
                return {
                  id: `${table}#${n}`,
                  ...(table === "calendar_events" && { series_id: null, status: "scheduled" }),
                  ...v,
                };
              });
              (tables[table] ??= []).push(...inserted);
              return b;
            },
            delete: () => {
              deleting = true;
              return b;
            },
            eq: (col: string, val: unknown) => {
              filters.push((r) => r[col] === val);
              return b;
            },
            neq: (col: string, val: unknown) => {
              filters.push((r) => r[col] !== val);
              return b;
            },
            in: (col: string, vals: unknown[]) => {
              filters.push((r) => vals.includes(r[col]));
              return b;
            },
            gte: (col: string, val: string) => {
              filters.push((r) => String(r[col]) >= val);
              return b;
            },
            lte: (col: string, val: string) => {
              filters.push((r) => String(r[col]) <= val);
              return b;
            },
            not: (col: string) => {
              filters.push((r) => r[col] != null);
              return b;
            },
            order: () => b,
            limit: () => b,
            maybeSingle: one,
            single: one,
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve().then(result).then(resolve, reject),
          };
          return b;
        },
      },
    };
  }

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // The shared function answers an edit with nothing in it as a success that
  // changed nothing, which the screen can never send. From an agent it is a
  // field left out or misplaced, and a 200 would read as "done".
  it("refuses an edit that names no field as 400, before touching the calendar", async () => {
    const fake = fakeCalendar({ calendar_events: [event(ONE_OFF)] });
    currentAdmin = fake.db;
    const res = await post({
      action: "edit_calendar_entry",
      params: { scope: "event", id: ONE_OFF },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.message).toMatch(/Nothing to change/);
    expect(fake.touched).toEqual([]);
  });

  describe("delete_calendar_entry", () => {
    const seed = () => ({
      calendar_events: [
        event(ONE_OFF),
        event(QUIET_ONE_OFF, { title: "Social" }),
        event(WEEKLY_DATE, { series_id: SERIES, title: "Evening class" }),
      ],
      session_checkins: [
        { id: "c1", event_id: ONE_OFF },
        { id: "c2", event_id: ONE_OFF },
        // Another date's check-in, which must not count against either one-off.
        { id: "c3", event_id: WEEKLY_DATE },
      ],
    });

    // Each refusal tells the agent its next move: 404 is "list again", 409 with
    // a series_id is "stop the repeat or cancel the date". Collapsed into one
    // status, an agent cannot choose.
    it.each([
      ["a date that is not there", MISSING, 404, "not_found", undefined],
      ["one date of a weekly entry", WEEKLY_DATE, 409, "repeating_date", { series_id: SERIES }],
    ])("refuses %s, deleting nothing", async (_what, id, status, code, details) => {
      const fake = fakeCalendar(seed());
      currentAdmin = fake.db;
      const res = await post({ action: "delete_calendar_entry", params: { id } });
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.error.code).toBe(code);
      expect(body.error.details).toEqual(details);
      expect(fake.writes).toEqual([]);
      expect(fake.tables.calendar_events).toHaveLength(3);
    });

    // The control for the refusals above: the fake can delete, so "deleted
    // nothing" there is a finding rather than something it could not do.
    it("deletes a one-off nobody was checked in to, logged under the token's owner", async () => {
      const audit = vi.spyOn(console, "info").mockImplementation(() => {});
      const fake = fakeCalendar(seed());
      currentAdmin = fake.db;
      const res = await post({ action: "delete_calendar_entry", params: { id: QUIET_ONE_OFF } });
      expect(res.status).toBe(200);
      expect((await res.json()).result).toEqual({
        deleted: true,
        id: QUIET_ONE_OFF,
        checkins_removed: 0,
      });
      expect(fake.writes).toEqual([
        { op: "delete", table: "calendar_events", values: [QUIET_ONE_OFF] },
      ]);
      expect(audit).toHaveBeenCalledWith(
        "[agent.delete_calendar_entry] audit",
        JSON.stringify({ eventId: QUIET_ONE_OFF, checkinsRemoved: 0, actor: TOKEN_OWNER }),
      );
    });

    // Once the class is gone its check-ins go too, as clean-up, and the agent
    // is told how many so it can tell the manager.
    it("deletes a one-off people were checked in to, and says how many check-ins went", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const fake = fakeCalendar(seed());
      currentAdmin = fake.db;
      const res = await post({ action: "delete_calendar_entry", params: { id: ONE_OFF } });
      expect(res.status).toBe(200);
      expect((await res.json()).result).toEqual({
        deleted: true,
        id: ONE_OFF,
        checkins_removed: 2,
      });
      expect(fake.writes).toEqual([{ op: "delete", table: "calendar_events", values: [ONE_OFF] }]);
    });
  });

  describe("create_calendar_entry", () => {
    // Sydney is on daylight time (+11:00) in December. An agent left to work
    // the offset out for itself would be right for half the year and an hour
    // out for the other half.
    it("reads a one-off's times as club time, and puts it at the gym unless told otherwise", async () => {
      const { DEFAULT_EVENT_LOCATION } = await import("@/lib/calendar");
      // A different class at the same moment is not the same entry, so it must
      // not stop this one going on.
      const fake = fakeCalendar({
        calendar_events: [event(WEEKLY_DATE, { series_id: SERIES, title: "Evening class" })],
      });
      currentAdmin = fake.db;
      const res = await post({ action: "create_calendar_entry", params: ONE_OFF_PARAMS });
      expect(res.status).toBe(200);
      expect(fake.writes).toEqual([
        {
          op: "insert",
          table: "calendar_events",
          values: {
            title: "Grading",
            description: null,
            instructor_name: null,
            location: DEFAULT_EVENT_LOCATION,
            visibility: "public",
            invite_only: false,
            created_by: TOKEN_OWNER,
            starts_at: "2026-12-03T07:00:00.000Z",
            ends_at: "2026-12-03T08:30:00.000Z",
          },
        },
      ]);
      expect((await res.json()).result).toEqual({
        repeats: false,
        event_id: "calendar_events#1",
        series_id: null,
        generated: 1,
        dates: [
          expect.objectContaining({
            id: "calendar_events#1",
            repeats: false,
            starts_at: "2026-12-03T07:00:00.000Z",
            starts_local: "2026-12-03T18:00",
            ends_local: "2026-12-03T19:30",
            weekday: WEEKDAY_LABELS[4],
            location: DEFAULT_EVENT_LOCATION,
          }),
        ],
      });
    });

    // A retry of a create that never heard back is the usual way this happens.
    // The details name the date already there, so the agent can report it
    // rather than add a second one under a new title.
    it("refuses a one-off already on the calendar as 409, naming the date, adding nothing", async () => {
      const fake = fakeCalendar({ calendar_events: [event(ONE_OFF)] });
      currentAdmin = fake.db;
      const res = await post({ action: "create_calendar_entry", params: ONE_OFF_PARAMS });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("already_on_calendar");
      expect(body.error.details).toEqual({
        event_id: ONE_OFF,
        series_id: null,
        status: "scheduled",
      });
      expect(fake.writes).toEqual([]);
    });

    describe("a weekly entry", () => {
      // Friday 30 October in Sydney: the last Thursday of a term ending on the
      // 29th was yesterday. Dates are only generated from today on, so "today"
      // decides whether this entry would ever show up.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-30T01:00:00Z"));
      });

      const weekly = (ends_on: string) => ({
        title: "Evening class",
        repeat: {
          type: "weekly",
          weekday: 4,
          start_time: "18:00",
          duration_minutes: 90,
          starts_on: "2026-07-23",
          ends_on,
        },
      });

      // Saved, it would be reported as added and never appear.
      it("refuses one whose last date has passed as 422 no_dates, before reading anything", async () => {
        const fake = fakeCalendar();
        currentAdmin = fake.db;
        const res = await post({ action: "create_calendar_entry", params: weekly("2026-10-29") });
        expect(res.status).toBe(422);
        expect((await res.json()).error.code).toBe("no_dates");
        expect(fake.touched).toEqual([]);
      });

      // The control: a week later and one Thursday is still to come. It also
      // pins the naming the route owns: a weekly entry's id is a series_id,
      // never an event_id, so it cannot be handed to a per-date action.
      it("adds one with a date still to come, reported by its series_id", async () => {
        const fake = fakeCalendar();
        currentAdmin = fake.db;
        const res = await post({ action: "create_calendar_entry", params: weekly("2026-11-05") });
        expect(res.status).toBe(200);
        expect((await res.json()).result).toEqual({
          repeats: true,
          event_id: null,
          series_id: "calendar_series#1",
          generated: 1,
          dates: [
            expect.objectContaining({
              id: "calendar_events#1",
              series_id: "calendar_series#1",
              repeats: true,
              starts_local: "2026-11-05T18:00",
              weekday: WEEKDAY_LABELS[4],
            }),
          ],
        });
      });
    });
  });

  describe("list_calendar_events", () => {
    // Invite only is a badge on a date and hides nothing (docs/calendar.md), so
    // what an agent is told is the date's own flag, the one edit_calendar_entry
    // writes and the calendar shows.
    it("reports each date's own invite only badge, whatever its weekly entry says", async () => {
      const BADGED = "a6666666-6666-4666-8666-666666666666";
      const fake = fakeCalendar({
        // Not active, so the horizon top-up has nothing to add.
        calendar_series: [{ id: SERIES, invite_only: true, is_active: false }],
        calendar_events: [
          event(WEEKLY_DATE, { series_id: SERIES, title: "Evening class" }),
          event(BADGED, { series_id: SERIES, title: "Evening class", invite_only: true }),
          event(ONE_OFF),
        ],
        event_rsvps: [],
      });
      currentAdmin = fake.db;
      const res = await post({ action: "list_calendar_events", params: {} });
      expect(res.status).toBe(200);
      const { events } = (await res.json()).result as { events: Row[] };
      expect(Object.fromEntries(events.map((e) => [e.id, e.invite_only]))).toEqual({
        [WEEKLY_DATE]: false,
        [BADGED]: true,
        [ONE_OFF]: false,
      });
      for (const e of events) expect(e).not.toHaveProperty("series_invite_only");
    });
  });

  // Every calendar schema is strict because the screen's would otherwise drop a
  // misspelt field and answer 200 for a change it never made (a misspelt
  // `visibility` puts an entry meant for members up for everybody to see, a
  // misspelt `invite_only` leaves its badge off); and list_calendar_events
  // takes nothing, so a `from` an agent hoped would narrow the list must not
  // come back as the whole list, read as filtered.
  it.each([
    [
      "a misspelt field on create_calendar_entry",
      "create_calendar_entry",
      { ...ONE_OFF_PARAMS, invite_ony: true },
      "invite_ony",
    ],
    ["any param on list_calendar_events", "list_calendar_events", { from: "2026-11-01" }, "from"],
  ])(
    "refuses %s as 400 invalid_params, naming it, before reading anything",
    async (_what, action, params, key) => {
      const fake = fakeCalendar({ calendar_events: [event(ONE_OFF)] });
      currentAdmin = fake.db;
      const res = await post({ action, params });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_params");
      expect(JSON.stringify(body.error.issues)).toContain(key);
      expect(fake.touched).toEqual([]);
    },
  );

  // A database error's own text names tables and columns. It belongs in the
  // server log, not in a response a token holder's agent may repeat anywhere.
  it.each([
    ["list_calendar_events", {}],
    ["delete_calendar_entry", { id: ONE_OFF }],
  ])(
    "answers a database failure in %s as 500 db_error, without the database's words",
    async (action, params) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      currentAdmin = fakeCalendar(
        { calendar_events: [event(ONE_OFF)] },
        { fail: { calendar_events: DB_TEXT } },
      ).db;
      const res = await post({ action, params });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("db_error");
      expect(JSON.stringify(body)).not.toContain("calendar_events");
      expect(JSON.stringify(body)).not.toContain("does not exist");
      expect(logged).toHaveBeenCalledWith("[agent] db_error:", DB_TEXT);
    },
  );
});
