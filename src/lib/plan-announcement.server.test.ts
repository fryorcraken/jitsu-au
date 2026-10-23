// Announcing a plan, end to end against an in-memory database and a stubbed
// send.
//
// The behaviours pinned here live in what the sender DOES, not in any pure
// helper: one email per household, a retried announcement emailing nobody
// twice, a failed send left pending rather than lost, and preferences never
// consulted for a kind nobody can switch off. The audience rule itself is pinned
// in `plan-announcement.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type SentEmail = { to: string; subject: string; idempotency_key: string; text: string };

const sendLovableEmail = vi.hoisted(() => vi.fn(async (_payload: SentEmail) => ({})));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));

const PARENT = "00000000-0000-4000-8000-000000000001";
const CHILD_A = "00000000-0000-4000-8000-000000000002";
const CHILD_B = "00000000-0000-4000-8000-000000000003";
const ADULT = "00000000-0000-4000-8000-000000000004";
const APPLICANT = "00000000-0000-4000-8000-000000000005";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const INSURANCE_ID = "22222222-2222-4222-8222-222222222222";
const ANNOUNCEMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const EMAILS: Record<string, string> = {
  [PARENT]: "ada@example.com",
  [ADULT]: "eve@example.com",
  [APPLICANT]: "sam@example.com",
};

type Row = Record<string, unknown>;

/**
 * Just enough of PostgREST's query builder for the reads and writes the
 * announcement makes. Filters compose; awaiting the builder runs it.
 */
function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const reads: string[] = [];
  let nextId = 1;
  let clock = Date.parse("2026-11-03T01:00:00.000Z");

  class Query implements PromiseLike<{ data: unknown; error: null }> {
    private filters: ((r: Row) => boolean)[] = [];
    private cap = Infinity;
    private from = 0;
    private mode: "select" | "upsert" | "update" = "select";
    private payload: Row[] | Row = [];
    private single = false;
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    is(c: string, v: unknown) {
      this.filters.push((r) => (r[c] ?? null) === v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.cap = n;
      return this;
    }
    range(a: number, b: number) {
      this.from = a;
      this.cap = b - a + 1;
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    upsert(rows: Row[]) {
      this.mode = "upsert";
      this.payload = rows;
      return this;
    }
    update(values: Row) {
      this.mode = "update";
      this.payload = values;
      return this;
    }
    private run() {
      const rows = (tables[this.table] ??= []);
      if (this.mode === "upsert") {
        // ON CONFLICT (user_id, kind, subject_id) DO NOTHING
        const inserted: Row[] = [];
        for (const r of this.payload as Row[]) {
          const clash = rows.some(
            (x) => x.user_id === r.user_id && x.kind === r.kind && x.subject_id === r.subject_id,
          );
          if (clash) continue;
          const row = {
            ...r,
            id: `row-${nextId++}`,
            emailed_at: null,
            read_at: null,
            created_at: new Date((clock += 1000)).toISOString(),
          };
          rows.push(row);
          inserted.push(row);
        }
        return { data: inserted, error: null };
      }
      const hits = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.mode === "update") {
        for (const r of hits) Object.assign(r, this.payload);
        return { data: null, error: null };
      }
      reads.push(this.table);
      const page = hits.slice(this.from, this.from + this.cap);
      return { data: this.single ? (page[0] ?? null) : page, error: null };
    }
    then<A = { data: unknown; error: null }, B = never>(
      ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null,
      no?: ((e: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return Promise.resolve(this.run() as { data: unknown; error: null }).then(ok, no);
    }
  }

  const db = {
    from: (table: string) => new Query(table),
    rpc: (name: string, args: { _user_ids: string[] }) => {
      if (name !== "user_emails") throw new Error(`unexpected rpc ${name}`);
      return Promise.resolve({
        data: args._user_ids.flatMap((id) =>
          EMAILS[id] ? [{ user_id: id, email: EMAILS[id], email_confirmed_at: null }] : [],
        ),
        error: null,
      });
    },
  };
  return { db: db as unknown as SupabaseClient<Database>, tables, reads };
}

const plan = (over: Row = {}): Row => ({
  id: PLAN_ID,
  code: "2027-s1",
  name: "Semester 1 2027",
  description: null,
  kind: "period",
  public_price_cents: 44500,
  student_price_cents: 24500,
  starts_on: "2027-03-01",
  ends_on: "2027-06-30",
  duration_days: null,
  session_credits: null,
  is_active: true,
  sort_order: 1,
  ...over,
});

function club() {
  return fakeDb({
    membership_plans: [
      plan(),
      plan({
        id: INSURANCE_ID,
        code: "insurance_yearly",
        name: "Yearly insurance",
        kind: "insurance",
        public_price_cents: 9000,
        student_price_cents: null,
        starts_on: null,
        ends_on: null,
        duration_days: 365,
      }),
    ],
    profiles: [
      { user_id: PARENT, guardian_user_id: null, first_name: "Ada", last_name: "Example" },
      { user_id: CHILD_A, guardian_user_id: PARENT, first_name: "Cy", last_name: "Example" },
      { user_id: CHILD_B, guardian_user_id: PARENT, first_name: "Bea", last_name: "Example" },
      { user_id: ADULT, guardian_user_id: null, first_name: "Eve", last_name: "Example" },
      { user_id: APPLICANT, guardian_user_id: null, first_name: "Sam", last_name: "Example" },
    ],
    waivers: [
      // The parent does not train: only the children's waivers are approved.
      { id: "w1", user_id: CHILD_A, approval_status: "approved" },
      { id: "w2", user_id: CHILD_B, approval_status: "approved" },
      { id: "w3", user_id: ADULT, approval_status: "approved" },
      { id: "w4", user_id: APPLICANT, approval_status: "pending" },
    ],
    memberships: [
      // Cy is insured into 2027; nobody else is.
      {
        id: "m1",
        user_id: CHILD_A,
        plan_id: INSURANCE_ID,
        status: "active",
        ends_at: "2099-01-01T00:00:00.000Z",
      },
    ],
    notifications: [],
  });
}

async function announce(db: SupabaseClient<Database>, announcementId = ANNOUNCEMENT) {
  const { announceMembershipPlan } = await import("./plan-announcement.server");
  return announceMembershipPlan(db, { planId: PLAN_ID, announcementId, actorId: null });
}

const sent = () => sendLovableEmail.mock.calls.map((c) => c[0]);

beforeEach(() => {
  sendLovableEmail.mockReset();
  sendLovableEmail.mockImplementation(async () => ({}));
  process.env.LOVABLE_API_KEY = "test-key";
});

describe("announceMembershipPlan", () => {
  it("emails each active inbox once, and nobody waiting on a waiver", async () => {
    const { db, tables } = club();
    const result = await announce(db);

    expect(sent().map((e) => e.to)).toEqual(["ada@example.com", "eve@example.com"]);
    expect(result).toMatchObject({ recipients: 2, emailed: 2, pending: 0 });
    // One row per inbox, every one of them stamped.
    expect(tables.notifications).toHaveLength(2);
    expect(tables.notifications.every((r) => r.emailed_at)).toBe(true);
  });

  it("sends a family one email that names the children, and says who needs insurance", async () => {
    const { db } = club();
    await announce(db);
    const family = sent().find((e) => e.to === "ada@example.com")!;
    expect(family.subject).toBe("Semester 1 2027 at UTS Jitsu");
    expect(family.text).toContain("for Bea and Cy");
    expect(family.text).toContain("$445, or $245 for UTS students");
    expect(family.text).toContain("1 Mar 2027 to 30 Jun 2027");
    // Cy is covered; Bea is not. The parent does not train, so is not named.
    expect(family.text).toContain("To train, Bea will also need yearly insurance ($90)");
    expect(family.text).toContain(`/membership#plan-${PLAN_ID}`);
    expect(family.text).not.toContain("—");
  });

  // No switch governs this kind, so nothing may even ask the switches.
  it("never reads anybody's email preferences", async () => {
    const { db, reads } = club();
    await announce(db);
    expect(reads).not.toContain("notification_preferences");
  });

  it("emails nobody twice when the same announcement is retried", async () => {
    const { db, tables } = club();
    await announce(db);
    sendLovableEmail.mockClear();

    const again = await announce(db);
    expect(sent()).toEqual([]);
    expect(tables.notifications).toHaveLength(2);
    expect(again).toMatchObject({ recipients: 2, emailed: 2, pending: 0 });
  });

  it("leaves a failed send pending, and a retry sends only that one", async () => {
    const { db } = club();
    sendLovableEmail.mockImplementation(async (p: SentEmail) => {
      if (p.to === "eve@example.com") throw new Error("provider down");
      return {};
    });
    const first = await announce(db);
    expect(first).toMatchObject({ recipients: 2, emailed: 1, pending: 1 });

    sendLovableEmail.mockReset();
    sendLovableEmail.mockImplementation(async () => ({}));
    const retry = await announce(db);
    expect(sent().map((e) => e.to)).toEqual(["eve@example.com"]);
    expect(retry).toMatchObject({ recipients: 2, emailed: 2, pending: 0 });
  });

  it("keys each send on its row, so two overlapping calls send one email", async () => {
    const { db, tables } = club();
    await announce(db);
    const keys = sent().map((e) => e.idempotency_key);
    expect(keys).toEqual(tables.notifications.map((r) => `plan-announcement-${r.id}`));
  });

  it("announces again under a new id, and the summary counts both", async () => {
    const { db } = club();
    await announce(db);
    sendLovableEmail.mockClear();
    await announce(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(sent()).toHaveLength(2);

    const { loadAnnouncementSummaries } = await import("./plan-announcement.server");
    const summary = (await loadAnnouncementSummaries(db)).get(PLAN_ID);
    expect(summary).toMatchObject({
      announcement_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      recipients: 2,
      times: 2,
    });
  });

  it("writes the rows but sends nothing when email is not configured", async () => {
    delete process.env.LOVABLE_API_KEY;
    const { db } = club();
    const result = await announce(db);
    expect(sent()).toEqual([]);
    // Still owed, so the next morning's summary picks them up.
    expect(result).toMatchObject({ recipients: 2, emailed: 0, pending: 2 });
  });

  it("refuses an id already used for another plan", async () => {
    const { db, tables } = club();
    tables.notifications.push({
      id: "old",
      user_id: ADULT,
      kind: "membership_plan_open",
      subject_id: ANNOUNCEMENT,
      href: "/membership#plan-33333333-3333-4333-8333-333333333333",
      emailed_at: "2026-11-01T00:00:00.000Z",
      created_at: "2026-11-01T00:00:00.000Z",
    });
    await expect(announce(db)).rejects.toMatchObject({ code: "submission_conflict" });
    expect(sent()).toEqual([]);
  });

  it("refuses a plan that does not exist", async () => {
    const { db } = club();
    const { announceMembershipPlan } = await import("./plan-announcement.server");
    await expect(
      announceMembershipPlan(db, {
        planId: "44444444-4444-4444-8444-444444444444",
        announcementId: ANNOUNCEMENT,
        actorId: null,
      }),
    ).rejects.toMatchObject({ code: "plan_not_found" });
  });
});
