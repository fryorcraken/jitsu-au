// The daily digest, from the side #102 cares about: one family, one inbox, one
// email.
//
// This drives `sendDailyDigests` against a fake database and a stubbed send,
// because the behaviour being pinned is not in any pure helper. The grouping,
// the idempotency key and the stamping are decisions the sender makes, and the
// bug they fix ("three children produce three emails into one inbox on one
// morning, all accepted as distinct") is only visible end to end.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** The one payload field set this test reads back off the stubbed send. */
type SentEmail = { to: string; subject: string; idempotency_key: string; text: string };

const sendLovableEmail = vi.hoisted(() =>
  vi.fn(
    async (_payload: {
      to: string;
      subject: string;
      idempotency_key: string;
      text: string;
    }) => ({}),
  ),
);
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));

const PARENT = "parent";
const CHILD_A = "child-a";
const CHILD_B = "child-b";
const CHILD_C = "child-c";
const STRANGER = "stranger";

const LINKS = [
  { user_id: PARENT, guardian_user_id: null, first_name: "Ada", last_name: "Lovelace" },
  { user_id: CHILD_A, guardian_user_id: PARENT, first_name: "Bea", last_name: "Lovelace" },
  { user_id: CHILD_B, guardian_user_id: PARENT, first_name: "Cy", last_name: "Lovelace" },
  { user_id: CHILD_C, guardian_user_id: PARENT, first_name: "Di", last_name: "Lovelace" },
  { user_id: STRANGER, guardian_user_id: null, first_name: "Eve", last_name: "Babbage" },
];

type PendingRow = {
  id: string;
  user_id: string;
  kind: string;
  subject_id: string;
  title: string;
  body: string | null;
  href: string;
  read_at: string | null;
  created_at: string;
};

/**
 * A service-role fake serving every read the digest makes, and recording the
 * `emailed_at` stamps so a test can prove nothing was left owed.
 */
function fakeDb(pending: PendingRow[]) {
  const stamped: string[][] = [];
  const tokenRows: { user_id: string; token: string }[] = [];

  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "user_emails") {
        const ids = args._user_ids as string[];
        return Promise.resolve({
          data: ids
            .filter((id) => id === PARENT || id === STRANGER)
            .map((id) => ({
              user_id: id,
              email: id === PARENT ? "ada@example.com" : "eve@example.com",
            })),
          error: null,
        });
      }
      // has_role: nobody here is a manager.
      return Promise.resolve({ data: false, error: null });
    },
    from: (table: string) => {
      if (table === "notifications") {
        return {
          select: () => ({
            is: () => ({
              order: () => ({ limit: () => Promise.resolve({ data: pending, error: null }) }),
            }),
          }),
          update: () => ({
            in: (_c: string, ids: string[]) => {
              stamped.push(ids);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            in: (_c: string, ids: string[]) =>
              Promise.resolve({ data: LINKS.filter((r) => ids.includes(r.user_id)), error: null }),
            eq: (_c: string, id: string) => ({
              maybeSingle: () =>
                Promise.resolve({ data: LINKS.find((r) => r.user_id === id) ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === "notification_preferences") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              // New-post announcements are OFF by club default, so the parent
              // has switched theirs on. The children's are left OFF, which is
              // the assertion hiding in this fake: the mail lands in the
              // parent's inbox, so it is the PARENT's switch that governs it.
              // Reading a child's would suppress an email the parent asked for.
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    id === PARENT || id === STRANGER
                      ? { new_blog_post: true }
                      : { new_blog_post: false },
                }),
            }),
          }),
        };
      }
      if (table === "notification_tokens") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: () =>
                Promise.resolve({ data: tokenRows.find((t) => t.user_id === id) ?? null }),
            }),
          }),
          insert: (row: { user_id: string; token: string }) => {
            tokenRows.push({ user_id: row.user_id, token: row.token });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { db, stamped, tokenRows };
}

const post = (id: string, userId: string, subjectId = "post-1"): PendingRow => ({
  id,
  user_id: userId,
  kind: "new_blog_post",
  subject_id: subjectId,
  title: "New post: Grading day",
  body: null,
  href: "/blog/grading-day",
  read_at: null,
  created_at: "2026-08-30T01:00:00Z",
});

describe("sendDailyDigests, for a household", () => {
  beforeEach(() => {
    sendLovableEmail.mockClear();
    process.env.LOVABLE_API_KEY = "test-key";
  });

  it("sends one email for a parent and three children, not four", async () => {
    const { sendDailyDigests } = await import("./notification-email.server");
    const { db, stamped } = fakeDb([
      post("n1", PARENT),
      post("n2", CHILD_A),
      post("n3", CHILD_B),
      post("n4", CHILD_C),
    ]);

    const result = await sendDailyDigests(db, new Date("2026-08-30T22:00:00Z"));

    expect(sendLovableEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ considered: 4, recipients: 1, sent: 1 });

    const [payload] = sendLovableEmail.mock.calls[0] as [SentEmail];
    // To the parent's mailbox, keyed on the parent. Before this the key was
    // `digest-${userId}-${day}`, which made the four sends distinct by
    // construction and so passed every idempotency check there was.
    expect(payload.to).toBe("ada@example.com");
    expect(payload.idempotency_key).toBe("digest-parent-2026-08-31");
    // One post, said once. Four identical lines would read as four posts.
    expect(payload.subject).toBe("1 new thing at UTS Jitsu");

    // Every row stamped, including the three the merge folded away. Leaving
    // those pending would mail the same post again tomorrow.
    expect(stamped.flat().sort()).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("still sends a separate email to an unrelated household", async () => {
    const { sendDailyDigests } = await import("./notification-email.server");
    // The grouping folds a family together; it must not fold the club
    // together. A person with no guardian and no dependants is their own
    // contact, so nothing changes for the people this already worked for.
    const { db } = fakeDb([post("n1", PARENT), post("n2", CHILD_A), post("n3", STRANGER)]);

    const result = await sendDailyDigests(db, new Date("2026-08-30T22:00:00Z"));

    expect(result).toEqual({ considered: 3, recipients: 2, sent: 2 });
    const to = (sendLovableEmail.mock.calls as [SentEmail][]).map(([p]) => p.to).sort();
    expect(to).toEqual(["ada@example.com", "eve@example.com"]);
  });

  it("gives the family ONE settings link, the parent's", async () => {
    const { sendDailyDigests } = await import("./notification-email.server");
    const { db, tokenRows } = fakeDb([post("n1", CHILD_A), post("n2", CHILD_B)]);

    await sendDailyDigests(db, new Date("2026-08-30T22:00:00Z"));

    // `notification_tokens` is one row per inbox. A token per child would hand
    // the parent a different "email settings" link in every email, each
    // governing only that child's mail.
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0].user_id).toBe(PARENT);
  });

  it("names two different events separately in the one email", async () => {
    const { sendDailyDigests } = await import("./notification-email.server");
    const { db } = fakeDb([
      post("n1", CHILD_A, "post-1"),
      { ...post("n2", CHILD_B, "post-2"), title: "New post: Timetable" },
    ]);

    await sendDailyDigests(db, new Date("2026-08-30T22:00:00Z"));

    const [payload] = sendLovableEmail.mock.calls[0] as [SentEmail];
    expect(payload.subject).toBe("2 new things at UTS Jitsu");
    expect(payload.text).toContain("Grading day");
    expect(payload.text).toContain("Timetable");
  });
});

describe("when households cannot be read at all", () => {
  beforeEach(() => {
    sendLovableEmail.mockClear();
    process.env.LOVABLE_API_KEY = "test-key";
  });

  /** A db whose `profiles` reads all fail. */
  function brokenProfiles(db: SupabaseClient<Database>) {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "from") {
          return (table: string) => {
            if (table === "profiles") {
              return {
                select: () => ({
                  in: () => Promise.resolve({ data: null, error: { message: "boom" } }),
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
                  }),
                }),
              };
            }
            return (target as unknown as { from: (t: string) => unknown }).from(table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it("fails the run rather than guessing who reads what", async () => {
    // The tempting alternative is to fall back to grouping by `user_id`, which
    // looks like graceful degradation and is data loss: a dependant's own
    // preferences have announcements OFF by club default, so their rows would
    // be judged unwanted, stamped, and never mentioned to the parent who was
    // owed them. Failing costs a day and loses nothing.
    const { sendDailyDigests } = await import("./notification-email.server");
    const { db } = fakeDb([post("n1", PARENT), post("n2", CHILD_A)]);
    await expect(
      sendDailyDigests(brokenProfiles(db), new Date("2026-08-30T22:00:00Z")),
    ).rejects.toThrow("boom");
  });

  it("stamps nothing, so tomorrow tries again", async () => {
    // The half that matters more than the sending. A run that stamped rows it
    // never sent would swallow a day of everybody's notifications, silently,
    // with no way to get them back.
    const { sendDailyDigests } = await import("./notification-email.server");
    const { db, stamped } = fakeDb([post("n1", PARENT), post("n2", CHILD_A)]);
    await expect(
      sendDailyDigests(brokenProfiles(db), new Date("2026-08-30T22:00:00Z")),
    ).rejects.toThrow();
    expect(stamped.flat()).toEqual([]);
    expect(sendLovableEmail).not.toHaveBeenCalled();
  });
});
