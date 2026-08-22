// Route-handler coverage for the two behaviours introduced by the dev-probe
// fixes that have no seam in src/lib/: the 405 response for non-GET/POST
// methods, and list_invoices's count/total split. Both are plain functions on
// the exported Route (no AsyncLocalStorage/Start context involved), so they're
// reachable directly — see membership.functions.test.ts for why that isn't
// true of createServerFn handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/lib/manager-api-tokens";

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
      if (name === "has_role") return Promise.resolve(ok(true));
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
    const { WaiverTemplateError } = await import("@/lib/waiver-template-editor");
    return new WaiverTemplateError(message, reason, version);
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
