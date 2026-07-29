// A failed query must never be indistinguishable from "there is nothing there".
//
// `assignTrialMembership` is the one place that rule is reachable from a unit
// test — it is a plain exported helper rather than a `createServerFn`, and the
// same two reads decide both whether the club HAS a free trial and whether this
// person has already had one. Swallowing either error turns a database blip into
// a silent product decision: no trial for someone who just got approved, or a
// second free trial for someone who already trained on their first.
//
// The list screens (`listClubUsers`, the manager agent API) share the defect but
// not the seam; see issue #72 on whether route/server-function tests get built.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };

const ok = (data: unknown): Result => ({ data, error: null });
const fails = (message: string): Result => ({ data: null, error: { message } });

const TRIAL_PLAN = {
  id: "plan-trial",
  code: "trial",
  name: "Free trial",
  kind: "trial",
  is_active: true,
  duration_days: 30,
  session_credits: null,
  price_cents: 0,
};

/**
 * A fake service-role client covering exactly the chains the trial assignment
 * walks. Each read is supplied per-test so a single one can be made to fail
 * while the rest succeed — the shape of a real outage.
 */
function fakeAdmin(reads: {
  trialPlans?: Result;
  existingTrial?: Result;
  profile?: Result;
  inserted?: Result;
}) {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];

  const trialPlans = reads.trialPlans ?? ok([TRIAL_PLAN]);
  const existingTrial = reads.existingTrial ?? ok(null);
  const profile = reads.profile ?? ok({ first_name: "Ada", last_name: "Lovelace" });
  const inserted =
    reads.inserted ??
    ok({ id: "mem-1", user_id: "user-1", plan_id: TRIAL_PLAN.id, price_cents: 0 });

  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, _val: unknown) => {
          if (table === "membership_plans") return Promise.resolve(trialPlans);
          if (table === "profiles") return { maybeSingle: () => Promise.resolve(profile) };
          // memberships: the "have they had a trial before" guard.
          return {
            in: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(existingTrial) }) }),
          };
        },
      }),
      insert: (row: unknown) => {
        inserts.push(row);
        return { select: () => ({ single: () => Promise.resolve(inserted) }) };
      },
      update: (patch: unknown) => {
        updates.push(patch);
        return { eq: () => Promise.resolve(ok(null)) };
      },
    }),
  };

  return { admin, inserts, updates };
}

/** The module under test lazy-imports the admin client; hand it the fake. */
let currentAdmin: unknown;
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentAdmin;
  },
}));

async function assignTrial(fake: ReturnType<typeof fakeAdmin>) {
  currentAdmin = fake.admin;
  const { assignTrialMembership } = await import("./membership.functions");
  return assignTrialMembership("user-1");
}

describe("assignTrialMembership", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assigns the trial and activates it", async () => {
    const fake = fakeAdmin({});
    await assignTrial(fake);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({ user_id: "user-1", plan_id: TRIAL_PLAN.id });
    expect(fake.updates[0]).toMatchObject({ status: "active" });
  });

  it("skips someone who has already had a trial", async () => {
    const fake = fakeAdmin({ existingTrial: ok({ id: "mem-old" }) });
    await assignTrial(fake);
    expect(fake.inserts).toHaveLength(0);
  });

  it("skips silently when the club has no trial plan", async () => {
    const fake = fakeAdmin({ trialPlans: ok([]) });
    await assignTrial(fake);
    expect(fake.inserts).toHaveLength(0);
  });

  // The two that used to pass silently.
  it("throws rather than granting a second trial when the guard read fails", async () => {
    const fake = fakeAdmin({ existingTrial: fails("connection reset") });
    await expect(assignTrial(fake)).rejects.toThrow("connection reset");
    expect(fake.inserts).toHaveLength(0);
  });

  it("throws rather than skipping the trial when the plan read fails", async () => {
    const fake = fakeAdmin({ trialPlans: fails("permission denied for table membership_plans") });
    await expect(assignTrial(fake)).rejects.toThrow("permission denied");
    expect(fake.inserts).toHaveLength(0);
  });

  it("throws when the profile read fails rather than mislabelling the payment reference", async () => {
    const fake = fakeAdmin({ profile: fails("statement timeout") });
    await expect(assignTrial(fake)).rejects.toThrow("statement timeout");
    expect(fake.inserts).toHaveLength(0);
  });
});
