// The daily insurance run, end to end against an in-memory database.
//
// The rules are unit-tested in `insurance-reminders.test.ts`. What this pins is
// what only the sender decides: one email per inbox, a second run that sends
// nothing new, a withdrawn reminder, and a failed send left owed rather than
// stamped.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Sent = { to: string; subject: string; idempotency_key: string; text: string };
const sendLovableEmail = vi.hoisted(() => vi.fn(async (_payload: Sent) => ({})));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));

import { clubDayStart } from "./validation";

type Row = Record<string, unknown>;

/**
 * Just enough of PostgREST's builder for this module: filters are recorded and
 * applied when the query is awaited.
 */
function fakeDb(tables: Record<string, Row[]>, emails: Record<string, string>) {
  let nextId = 1;
  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "delete" | "update" | "upsert" = "select";
    let patch: Row = {};
    let upserted: Row[] = [];
    const rows = () => (tables[table] ??= []);
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "") >= v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      is: (c: string, v: null) => (filters.push((r) => (r[c] ?? null) === v), b),
      not: (c: string, _op: string, _v: null) => (filters.push((r) => r[c] != null), b),
      limit: () => b,
      delete: () => ((op = "delete"), b),
      update: (p: Row) => ((op = "update"), (patch = p), b),
      upsert: (drafts: Row[]) => {
        op = "upsert";
        for (const d of drafts) {
          const clash = rows().some(
            (r) => r.user_id === d.user_id && r.kind === d.kind && r.subject_id === d.subject_id,
          );
          if (clash) continue;
          const row = { id: `n${nextId++}`, emailed_at: null, ...d };
          rows().push(row);
          upserted.push(row);
        }
        return b;
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => void) {
        const hit = (r: Row) => filters.every((f) => f(r));
        if (op === "upsert") return resolve({ data: upserted, error: null });
        if (op === "delete") {
          tables[table] = rows().filter((r) => !hit(r));
          return resolve({ data: null, error: null });
        }
        if (op === "update") {
          for (const r of rows()) if (hit(r)) Object.assign(r, patch);
          return resolve({ data: null, error: null });
        }
        return resolve({ data: rows().filter(hit), error: null });
      },
    };
    upserted = [];
    return b;
  }
  const db = {
    from: query,
    rpc: (name: string, args: { _user_ids: string[] }) => {
      if (name !== "user_emails") throw new Error(`unexpected rpc ${name}`);
      return Promise.resolve({
        data: args._user_ids
          .filter((id) => emails[id])
          .map((id) => ({ user_id: id, email: emails[id] })),
        error: null,
      });
    },
  };
  return db as unknown as SupabaseClient<Database>;
}

const NOW = new Date("2027-03-01T22:00:00.000Z"); // 2 March, 9am in Sydney
const ends = (day: string) => clubDayStart(day);

function club() {
  return {
    membership_plans: [
      // Kind is the only control: the code here is deliberately not the
      // `insurance_yearly` the live plan carries.
      { id: "plan-ins", kind: "insurance", code: "cover-2027" },
      { id: "plan-sem", kind: "period", code: "2027-s1" },
    ],
    profiles: [
      { user_id: "ada", guardian_user_id: null, first_name: "Ada", last_name: "Lovelace" },
      { user_id: "bea", guardian_user_id: "ada", first_name: "Bea", last_name: "Lovelace" },
      { user_id: "cy", guardian_user_id: "ada", first_name: "Cy", last_name: "Lovelace" },
      { user_id: "di", guardian_user_id: "ada", first_name: "Di", last_name: "Lovelace" },
      { user_id: "eve", guardian_user_id: null, first_name: "Eve", last_name: "Babbage" },
    ],
    memberships: [
      // Two children ending the same day: one email naming both.
      {
        id: "m-bea",
        user_id: "bea",
        plan_id: "plan-ins",
        status: "active",
        ends_at: ends("2027-03-12"),
      },
      {
        id: "m-cy",
        user_id: "cy",
        plan_id: "plan-ins",
        status: "active",
        ends_at: ends("2027-03-12"),
      },
      // A third child ending another day: a separate email to the same inbox.
      {
        id: "m-di",
        user_id: "di",
        plan_id: "plan-ins",
        status: "active",
        ends_at: ends("2027-03-14"),
      },
      // Unpaid, and on her own: still reminded.
      {
        id: "m-eve",
        user_id: "eve",
        plan_id: "plan-ins",
        status: "active",
        ends_at: ends("2027-03-10"),
      },
      // Not insurance: never reminded, whatever its dates.
      {
        id: "m-sem",
        user_id: "eve",
        plan_id: "plan-sem",
        status: "active",
        ends_at: ends("2027-03-10"),
      },
      // Long ended: past the cap.
      {
        id: "m-old",
        user_id: "ada",
        plan_id: "plan-ins",
        status: "active",
        ends_at: ends("2026-01-01"),
      },
    ] as Row[],
    notifications: [] as Row[],
  };
}

const EMAILS = { ada: "ada@example.com", eve: "eve@example.com" };

describe("sendInsuranceReminders", () => {
  beforeEach(() => {
    sendLovableEmail.mockClear();
    sendLovableEmail.mockImplementation(async () => ({}));
    process.env.LOVABLE_API_KEY = "test-key";
  });

  it("sends one email per inbox per end day, naming each child, and stamps every row", async () => {
    const { sendInsuranceReminders } = await import("./insurance-reminders.server");
    const tables = club();
    const result = await sendInsuranceReminders(fakeDb(tables, EMAILS), NOW);

    expect(result).toMatchObject({ due: 4, written: 4, withdrawn: 0, sent: 3 });
    const sent = sendLovableEmail.mock.calls.map(([p]) => p);
    expect(sent.map((p) => [p.to, p.subject]).sort()).toEqual([
      ["ada@example.com", "Club insurance for Bea and Cy ends on 12 March"],
      ["ada@example.com", "Di's club insurance ends on 14 March"],
      ["eve@example.com", "Your club insurance ends on 10 March"],
    ]);
    // The parent is greeted; the child is who it is about.
    const bea = sent.find((p) => p.subject.includes("Bea and Cy"))!;
    expect(bea.text).toContain("Hi Ada");
    expect(bea.text).toContain("/membership");

    // Each row belongs to whoever reads the mail, so the parent sees the
    // children's reminders on their own /notifications. The covered person is
    // the subject, and the title names them.
    const rows = tables.notifications;
    expect(rows.map((r) => [r.user_id, r.kind, r.subject_id]).sort()).toEqual([
      ["ada", "insurance_ending_soon", "m-bea"],
      ["ada", "insurance_ending_soon", "m-cy"],
      ["ada", "insurance_ending_soon", "m-di"],
      ["eve", "insurance_ending_soon", "m-eve"],
    ]);
    expect(rows.every((r) => r.emailed_at)).toBe(true);
    expect(rows.find((r) => r.subject_id === "m-di")).toMatchObject({
      subject_type: "membership",
      title: "Di's club insurance ends on 14 March",
      href: "/membership?for=di",
    });
  });

  it("sends nothing new when the job runs again", async () => {
    const { sendInsuranceReminders } = await import("./insurance-reminders.server");
    const tables = club();
    const db = fakeDb(tables, EMAILS);
    await sendInsuranceReminders(db, NOW);
    sendLovableEmail.mockClear();

    const again = await sendInsuranceReminders(db, NOW);
    expect(again).toMatchObject({ written: 0, sent: 0 });
    expect(sendLovableEmail).not.toHaveBeenCalled();
    expect(tables.notifications).toHaveLength(4);
  });

  it("leaves a failed send owed, and sends it on the next run", async () => {
    const { sendInsuranceReminders } = await import("./insurance-reminders.server");
    const tables = club();
    const db = fakeDb(tables, EMAILS);
    sendLovableEmail.mockImplementation(async (p: Sent) => {
      if (p.to === "eve@example.com") throw new Error("provider down");
      return {};
    });
    const first = await sendInsuranceReminders(db, NOW);
    expect(first.sent).toBe(2);
    expect(tables.notifications.find((r) => r.user_id === "eve")?.emailed_at).toBeNull();

    sendLovableEmail.mockImplementation(async () => ({}));
    sendLovableEmail.mockClear();
    const second = await sendInsuranceReminders(db, NOW);
    expect(second.sent).toBe(1);
    expect(sendLovableEmail.mock.calls.map(([p]) => p.to)).toEqual(["eve@example.com"]);
  });

  it("withdraws a reminder nobody is owed any more, instead of sending it", async () => {
    const { sendInsuranceReminders } = await import("./insurance-reminders.server");
    const tables = club();
    const db = fakeDb(tables, EMAILS);
    // Written yesterday, never sent (no key that morning).
    delete process.env.LOVABLE_API_KEY;
    await sendInsuranceReminders(db, NOW);
    expect(sendLovableEmail).not.toHaveBeenCalled();
    expect(tables.notifications.every((r) => r.emailed_at === null)).toBe(true);

    // Eve renews before the next run.
    tables.memberships.push({
      id: "m-eve-2",
      user_id: "eve",
      plan_id: "plan-ins",
      status: "active",
      ends_at: ends("2028-03-10"),
    });
    process.env.LOVABLE_API_KEY = "test-key";
    const next = await sendInsuranceReminders(db, NOW);
    expect(next.withdrawn).toBe(1);
    expect(tables.notifications.some((r) => r.user_id === "eve")).toBe(false);
    expect(sendLovableEmail.mock.calls.map(([p]) => p.to)).not.toContain("eve@example.com");
  });

  it("says 'ends today' while a year bought at the counter still runs", async () => {
    const { sendInsuranceReminders } = await import("./insurance-reminders.server");
    const tables = club();
    // Bought at 7pm, so it ends at 7pm (08:00 UTC) on 10 March.
    tables.memberships = [
      { ...tables.memberships.find((m) => m.id === "m-eve")!, ends_at: "2027-03-10T08:00:00.000Z" },
    ];
    await sendInsuranceReminders(fakeDb(tables, EMAILS), new Date("2027-03-09T22:00:00.000Z"));
    expect(sendLovableEmail.mock.calls.map(([p]) => p.subject)).toEqual([
      "Your club insurance ends today",
    ]);
    expect(tables.notifications[0].title).toBe("Your club insurance ends on 10 March");
  });

  it("sends the 'ended' reminder on the day, and never the stale 'ending soon'", async () => {
    const { sendInsuranceReminders } = await import("./insurance-reminders.server");
    const tables = club();
    tables.memberships = tables.memberships.filter((m) => m.id === "m-eve");
    const db = fakeDb(tables, EMAILS);
    // 10 March in Sydney: Eve's end day.
    await sendInsuranceReminders(db, new Date("2027-03-09T22:00:00.000Z"));
    expect(sendLovableEmail.mock.calls.map(([p]) => p.subject)).toEqual([
      "Your club insurance ended today",
    ]);
  });
});

describe("loadInsuranceReminderStates", () => {
  it("reports the latest reminder sent and whether one is owed, for insurance rows only", async () => {
    const { sendInsuranceReminders, loadInsuranceReminderStates } =
      await import("./insurance-reminders.server");
    process.env.LOVABLE_API_KEY = "test-key";
    const tables = club();
    const db = fakeDb(tables, EMAILS);
    await sendInsuranceReminders(db, NOW);

    const states = await loadInsuranceReminderStates(
      db,
      tables.memberships as { id: string; user_id: string; plan_id: string }[],
      NOW,
    );
    expect(states.has("m-sem")).toBe(false);
    expect(states.get("m-eve")).toMatchObject({
      ends_within_14_days: true,
      owed: "insurance_ending_soon",
      last_sent: { kind: "insurance_ending_soon" },
    });
    // A child's state, though the row itself belongs to the parent.
    expect(states.get("m-bea")).toMatchObject({ last_sent: { kind: "insurance_ending_soon" } });
    expect(states.get("m-old")).toEqual({
      ends_within_14_days: false,
      owed: null,
      last_sent: null,
    });
  });
});

describe("countPeopleWithInsuranceEnding", () => {
  it("counts people owed the 'ending soon' reminder", async () => {
    const { countPeopleWithInsuranceEnding } = await import("./insurance-reminders.server");
    expect(await countPeopleWithInsuranceEnding(fakeDb(club(), EMAILS), NOW)).toBe(4);
  });
});
