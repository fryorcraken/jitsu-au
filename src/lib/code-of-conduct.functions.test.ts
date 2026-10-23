// Whose code-of-conduct standing this page reports.
//
// The rule worth pinning is the one that separates the two ways somebody can be
// identified here. A session is proof of who you are. An emailed link is proof
// of an ADDRESS and nothing more, and anyone can mint one of these for any
// address by signing a public waiver, so a link must never be able to read a
// household. That is one `if`, and without this file nothing would notice it
// going missing.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  codeOfConductSubject,
  highestAcceptedVersions,
  loadCodeOfConductStandard,
  promoteCodeOfConductVersion,
  saveCodeOfConductVersion,
} from "./code-of-conduct.functions";

const PARENT = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "aaaaaaaa-0000-4000-8000-000000000002";
const STRANGERS_CHILD = "aaaaaaaa-0000-4000-8000-000000000003";

/** A `profiles` table holding one family and one unrelated child. */
const admin = {
  from: (table: string) => {
    // Throws rather than answering, so a gate pointed at the wrong table stops
    // passing instead of quietly reading the right-shaped rows from anywhere.
    if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
    return {
      select: () => ({
        in: (_column: string, values: string[]) =>
          Promise.resolve({
            data: [
              { user_id: PARENT, guardian_user_id: null },
              { user_id: CHILD, guardian_user_id: PARENT },
              { user_id: STRANGERS_CHILD, guardian_user_id: "someone-else" },
            ].filter((r) => values.includes(r.user_id)),
            error: null,
          }),
      }),
    };
  },
} as unknown as SupabaseClient<Database>;

const signedIn = { userId: PARENT, signedIn: true };
const viaLink = { userId: PARENT, signedIn: false };

describe("codeOfConductSubject", () => {
  it("reports on the signer when no target was named", async () => {
    await expect(codeOfConductSubject(admin, signedIn, undefined)).resolves.toBe(PARENT);
    await expect(codeOfConductSubject(admin, viaLink, undefined)).resolves.toBe(PARENT);
  });

  it("lets a signed-in guardian ask about their own dependant", async () => {
    await expect(codeOfConductSubject(admin, signedIn, CHILD)).resolves.toBe(CHILD);
  });

  it("refuses a signed-in caller somebody else's dependant", async () => {
    await expect(codeOfConductSubject(admin, signedIn, STRANGERS_CHILD)).rejects.toThrow(
      /only see or change your own account/i,
    );
  });

  // The one that matters. A code-of-conduct token is handed back by the public
  // waiver submit, so possessing one proves nothing about who is holding it.
  it("refuses a target to somebody identified by an emailed link, even their own child", async () => {
    await expect(codeOfConductSubject(admin, viaLink, CHILD)).rejects.toThrow(/sign in/i);
  });

  // A link-identified caller asking about themselves is the ordinary
  // /code-of-conduct case and must keep working.
  it("still lets a link-identified caller read their own standing", async () => {
    await expect(codeOfConductSubject(admin, viaLink, PARENT)).resolves.toBe(PARENT);
  });
});

// ---- The document's versions ----
//
// Driven against a small store-backed fake, so the version numbers, the live
// flag and the replayed submission id are real state rather than canned replies.

type Row = Record<string, unknown>;

function versionStore(
  initial: Row[],
  opts: { failInsert?: boolean; acceptances?: Row[]; failAcceptances?: string } = {},
) {
  const rows = initial.map((r) => ({ ...r }));
  const reads: { table: string; range?: [number, number] }[] = [];
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let patch: Row | null = null;
    let insert: Row | null = null;
    const source = () =>
      table === "code_of_conduct_acceptances" ? (opts.acceptances ?? []) : rows;
    const matching = () => source().filter((r) => filters.every(([c, v]) => r[c] === v));
    const run = () => {
      reads.push({ table, ...(range ? { range } : {}) });
      if (table === "code_of_conduct_acceptances" && opts.failAcceptances)
        return { data: null, error: { message: opts.failAcceptances } };
      if (insert) {
        if (opts.failInsert) return { data: null, error: { message: "insert failed" } };
        const row = { id: `id-${insert.version}`, created_at: "now", ...insert };
        rows.push(row);
        return { data: row, error: null };
      }
      if (patch) {
        for (const r of matching()) Object.assign(r, patch);
        return { data: null, error: null };
      }
      let out = [...matching()];
      if (order) {
        const { col, asc } = order;
        out.sort((a, b) => ((a[col] as number) - (b[col] as number)) * (asc ? 1 : -1));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return { data: out, error: null };
    };
    const b = {
      select: () => b,
      insert: (r: Row) => ((insert = r), b),
      update: (p: Row) => ((patch = p), b),
      eq: (c: string, v: unknown) => (filters.push([c, v]), b),
      order: (col: string, o: { ascending: boolean }) => ((order = { col, asc: o.ascending }), b),
      limit: (n: number) => ((limit = n), b),
      range: (a: number, z: number) => ((range = [a, z]), b),
      single: () => Promise.resolve(run()),
      maybeSingle: () => {
        const r = run();
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
        return Promise.resolve({ data, error: r.error });
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  };
  return { admin: { from } as unknown as SupabaseClient<Database>, rows, reads };
}

const V1 = {
  id: "id-1",
  version: 1,
  title: "Code",
  body_md: "# Code",
  asks_reagreement: true,
  required_version: 1,
  is_current: true,
  client_submission_id: null,
  created_at: "then",
};

describe("saveCodeOfConductVersion", () => {
  const input = { title: "Code", body_md: "# Code, fixed", asks_reagreement: false };

  it("writes the next version and makes it the only live one", async () => {
    const store = versionStore([V1]);
    const saved = await saveCodeOfConductVersion(store.admin, input, "manager-1");
    expect(saved).toEqual({ id: "id-2", version: 2, is_current: true, already_saved: false });
    expect(store.rows.filter((r) => r.is_current).map((r) => r.version)).toEqual([2]);
    expect(store.rows.find((r) => r.version === 2)).toMatchObject({
      asks_reagreement: false,
      created_by: "manager-1",
    });
  });

  it("records the choice to ask everybody to agree again, and so requires itself", async () => {
    const store = versionStore([V1]);
    await saveCodeOfConductVersion(store.admin, { ...input, asks_reagreement: true }, null);
    expect(store.rows.find((r) => r.version === 2)).toMatchObject({
      asks_reagreement: true,
      required_version: 2,
    });
  });

  it("keeps what is required now for a correction, even after a rollback below an ask", async () => {
    const store = versionStore([
      { ...V1, is_current: true },
      { ...V1, id: "id-2", version: 2, required_version: 2, is_current: false },
    ]);
    await saveCodeOfConductVersion(store.admin, input, null);
    expect(store.rows.find((r) => r.version === 3)).toMatchObject({
      asks_reagreement: false,
      required_version: 1,
    });
  });

  it("refuses a repeated submission id carrying different text, rather than dropping it", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const store = versionStore([V1]);
    await saveCodeOfConductVersion(store.admin, { ...input, client_submission_id: id }, null);
    await expect(
      saveCodeOfConductVersion(
        store.admin,
        { ...input, body_md: "# Something else", client_submission_id: id },
        null,
      ),
    ).rejects.toMatchObject({ reason: "invalid", version: 2 });
    expect(store.rows).toHaveLength(2);
  });

  // The first attempt wrote the version and lost the promotion; the retry is
  // the caller asking for that save, so it finishes it.
  it("makes a replayed version live when the first attempt did not", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const store = versionStore([
      V1,
      {
        ...V1,
        ...input,
        id: "id-2",
        version: 2,
        required_version: 1,
        is_current: false,
        client_submission_id: id,
      },
    ]);
    const again = await saveCodeOfConductVersion(
      store.admin,
      { ...input, client_submission_id: id },
      null,
    );
    expect(again).toEqual({ id: "id-2", version: 2, is_current: true, already_saved: true });
    expect(store.rows.filter((r) => r.is_current).map((r) => r.version)).toEqual([2]);
  });

  // A save whose reply was lost, retried with the same id, must come back as
  // the version it already wrote rather than file a third.
  it("returns the version a repeated submission already wrote", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const store = versionStore([V1]);
    const first = await saveCodeOfConductVersion(
      store.admin,
      { ...input, client_submission_id: id },
      null,
    );
    const again = await saveCodeOfConductVersion(
      store.admin,
      { ...input, client_submission_id: id },
      null,
    );
    expect(again).toEqual({ ...first, already_saved: true });
    expect(store.rows).toHaveLength(2);
  });

  it("changes nothing live when the write fails", async () => {
    const store = versionStore([V1], { failInsert: true });
    await expect(saveCodeOfConductVersion(store.admin, input, null)).rejects.toMatchObject({
      reason: "not_published",
    });
    expect(store.rows.filter((r) => r.is_current).map((r) => r.version)).toEqual([1]);
  });
});

describe("promoteCodeOfConductVersion", () => {
  it("rolls back to an earlier version", async () => {
    const store = versionStore([
      { ...V1, is_current: false },
      { ...V1, id: "id-2", version: 2, is_current: true },
    ]);
    await expect(promoteCodeOfConductVersion(store.admin, "id-1")).resolves.toEqual({ version: 1 });
    expect(store.rows.filter((r) => r.is_current).map((r) => r.version)).toEqual([1]);
  });

  it("names the code of conduct when the version has gone", async () => {
    const store = versionStore([V1]);
    await expect(promoteCodeOfConductVersion(store.admin, "gone")).rejects.toThrow(
      "That code of conduct version no longer exists.",
    );
  });
});

describe("loadCodeOfConductStandard", () => {
  it("measures against what the live version requires", async () => {
    const store = versionStore([
      V1,
      { ...V1, id: "id-2", version: 2, asks_reagreement: false, required_version: 1 },
    ]);
    store.rows[0].is_current = false;
    store.rows[1].is_current = true;
    await expect(loadCodeOfConductStandard(store.admin)).resolves.toEqual({
      current_version: 2,
      required_version: 1,
    });
  });
});

describe("highestAcceptedVersions", () => {
  it("keeps one number per person, their highest", async () => {
    const store = versionStore([], {
      acceptances: [
        { id: "a", user_id: "ada", version: 1 },
        { id: "b", user_id: "ada", version: 3 },
        { id: "c", user_id: "bea", version: 2 },
      ],
    });
    await expect(highestAcceptedVersions(store.admin)).resolves.toEqual([3, 2]);
  });

  // PostgREST caps a response without saying so; a single read would undercount.
  it("reads past the first page", async () => {
    const acceptances = Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(5, "0"),
      user_id: `p${i}`,
      version: 1,
    }));
    const store = versionStore([], { acceptances });
    await expect(highestAcceptedVersions(store.admin)).resolves.toHaveLength(1001);
    expect(store.reads.map((r) => r.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("fails rather than undercounting", async () => {
    const store = versionStore([], { failAcceptances: "boom" });
    await expect(highestAcceptedVersions(store.admin)).rejects.toThrow("boom");
  });
});
