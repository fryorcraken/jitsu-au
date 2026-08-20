// Promoting a waiver version, driven against a fake client.
//
// `promoteWaiverTemplate` takes its client as a parameter for the same reason
// `applyCoverage` does in checkin.functions.ts: a `createServerFn` handler dies
// in the runner on "No Start context found in AsyncLocalStorage".
//
// What makes this worth pinning: the partial unique index allows exactly one
// `is_current = true`, so promoting is necessarily clear-then-set with a gap in
// between where the club has NO live waiver and `/waiver` refuses to render.
// The rules below are the ones that keep that gap from becoming an outage
// nobody notices — never open it needlessly, and never leave it silently.
import { describe, expect, it, vi } from "vitest";
import { WaiverTemplateError } from "./waiver-template-editor";
import {
  listWaiverTemplateRows,
  loadWaiverTemplateVersion,
  promoteWaiverTemplate,
  saveWaiverTemplateVersion,
} from "./waiver.functions";

type Result = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

type Op = {
  verb: "select" | "update";
  patch?: Record<string, unknown>;
  filters: [string, unknown][];
};

function fakeClient(respond: (op: Op, calls: Op[]) => Result) {
  const calls: Op[] = [];
  function chain(op: Op) {
    const settle = () => {
      calls.push(op);
      return Promise.resolve(respond(op, calls));
    };
    const builder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (op.filters.push([col, val]), builder),
      select: () => builder,
      maybeSingle: () => settle(),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return builder;
  }
  const admin = {
    from: () => ({
      select: () => chain({ verb: "select", filters: [] }),
      update: (patch: Record<string, unknown>) => chain({ verb: "update", patch, filters: [] }),
    }),
  };
  return { admin: admin as never, calls };
}

const updates = (calls: Op[]) => calls.filter((c) => c.verb === "update");
/** The write that would clear the live flag, i.e. the one that opens the gap. */
const clears = (calls: Op[]) => updates(calls).filter((c) => c.patch?.is_current === false).length;

describe("promoteWaiverTemplate", () => {
  it("promotes, clearing the old live version first", async () => {
    const { admin, calls } = fakeClient((op, all) => {
      if (op.verb === "select" && all.filter((c) => c.verb === "select").length === 1)
        return ok({
          id: "v2",
          version: 2,
          is_current: false,
          acknowledgements: [
            { id: "media", label: "I consent to being photographed.", required: false },
          ],
        });
      if (op.verb === "select") return ok({ id: "v1" });
      return ok(null);
    });
    await expect(promoteWaiverTemplate(admin, "v2")).resolves.toEqual({ version: 2 });
    const writes = updates(calls);
    expect(writes[0].patch).toEqual({ is_current: false });
    expect(writes[1].patch).toEqual({ is_current: true });
    expect(writes[1].filters).toContainEqual(["id", "v2"]);
  });

  it("refuses an unknown version without clearing anything", async () => {
    // The check has to come first. Clearing and then discovering the target does
    // not exist would cost the club its live waiver for a mistyped id.
    const { admin, calls } = fakeClient(() => ok(null));
    await expect(promoteWaiverTemplate(admin, "gone")).rejects.toThrow("no longer exists");
    expect(clears(calls)).toBe(0);
  });

  it("does nothing when the target is already live", async () => {
    const { admin, calls } = fakeClient(() => ok({ id: "v2", version: 2, is_current: true }));
    await expect(promoteWaiverTemplate(admin, "v2")).resolves.toEqual({ version: 2 });
    expect(updates(calls)).toHaveLength(0);
  });

  // The guard that stops a template silently losing photo-consent capture: see
  // `hasMediaAcknowledgement` in waiver-template-editor.ts. `saveWaiverTemplate`
  // ends by promoting the version it just inserted, so this single check also
  // covers a manager saving a template whose media item was cleared or never
  // existed, not just a direct promote of an old stored version.
  it("refuses to promote a version with no media consent acknowledgement, without clearing anything", async () => {
    const { admin, calls } = fakeClient(() =>
      ok({
        id: "v2",
        version: 2,
        is_current: false,
        acknowledgements: [{ id: "risk", label: "I accept the risks.", required: true }],
      }),
    );
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow(
      "no media consent acknowledgement",
    );
    expect(clears(calls)).toBe(0);
  });

  it("refuses to promote a version whose media item's label is blank", async () => {
    const { admin, calls } = fakeClient(() =>
      ok({
        id: "v2",
        version: 2,
        is_current: false,
        acknowledgements: [{ id: "media", label: "   ", required: false }],
      }),
    );
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow(
      "no media consent acknowledgement",
    );
    expect(clears(calls)).toBe(0);
  });

  it("puts the previous version back when the promotion fails", async () => {
    const { admin, calls } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({
          id: "v2",
          version: 2,
          is_current: false,
          acknowledgements: [
            { id: "media", label: "I consent to being photographed.", required: false },
          ],
        });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      // The post-failure re-read: nothing is live, so this is a real failure
      // rather than another manager having won the race.
      if (op.verb === "select") return ok(null);
      if (op.patch?.is_current === true && op.filters.some(([, v]) => v === "v2"))
        return { data: null, error: { message: "boom" } };
      return ok(null);
    });
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow("boom");
    const restore = updates(calls).at(-1);
    expect(restore?.patch).toEqual({ is_current: true });
    expect(restore?.filters).toContainEqual(["id", "v1"]);
  });

  it("explains a lost race instead of surfacing the constraint", async () => {
    // Another manager promoted while we were between our own two writes, so our
    // set hit the unique index. Something IS live, so nothing is broken — but
    // "duplicate key value violates unique constraint" tells a manager nothing.
    const { admin } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({
          id: "v2",
          version: 2,
          is_current: false,
          acknowledgements: [
            { id: "media", label: "I consent to being photographed.", required: false },
          ],
        });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      if (op.verb === "select") return ok({ id: "v3" });
      if (op.patch?.is_current === true)
        return { data: null, error: { message: "duplicate key value violates unique constraint" } };
      return ok(null);
    });
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow(
      /Someone else changed the live waiver/,
    );
  });

  it("says the signing page is down when the restore also fails", async () => {
    // Both writes failed and nothing is live. A generic error would be shrugged
    // at; this is the one case where a manager has to act immediately.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({
          id: "v2",
          version: 2,
          is_current: false,
          acknowledgements: [
            { id: "media", label: "I consent to being photographed.", required: false },
          ],
        });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      if (op.verb === "select") return ok(null);
      // The clear succeeds — that is what opens the gap. Both writes that could
      // close it again fail.
      if (op.patch?.is_current === false) return ok(null);
      return { data: null, error: { message: "boom" } };
    });
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow(/no live waiver/);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ---- The rest of the template surface, extracted so the manager agent API
// saves and reads through exactly the code the editor screen does. These run
// against a fake that actually holds rows, because what is worth pinning is the
// SEQUENCE (refuse before writing, insert as a draft, then promote) and a fake
// that answered every read the same way would pass with the order reversed.

type StoredRow = {
  id: string;
  version: number;
  title: string;
  body_md: string;
  acknowledgements: unknown;
  is_current: boolean;
  created_at: string;
};

const MEDIA_ACK = { id: "media", label: "I consent to being photographed.", required: false };

function row(over: Partial<StoredRow> & { version: number }): StoredRow {
  return {
    id: `v${over.version}`,
    title: `Training Waiver v${over.version}`,
    body_md: "Body",
    acknowledgements: [MEDIA_ACK],
    is_current: false,
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** A store-backed fake covering the chains these three functions walk. */
function fakeStore(rows: StoredRow[]) {
  const inserts: Record<string, unknown>[] = [];
  const writes: string[] = [];

  type Opts = { descending?: boolean; limit?: number };
  function read(filters: [string, unknown][], opts: Opts) {
    let out = rows.filter((r) =>
      filters.every(([col, val]) => (r as unknown as Record<string, unknown>)[col] === val),
    );
    if (opts.descending) out = [...out].sort((a, b) => b.version - a.version);
    if (opts.limit !== undefined) out = out.slice(0, opts.limit);
    return out;
  }

  function selectBuilder(filters: [string, unknown][], opts: Opts) {
    const builder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => selectBuilder([...filters, [col, val]], opts),
      order: () => selectBuilder(filters, { ...opts, descending: true }),
      limit: (n: number) => selectBuilder(filters, { ...opts, limit: n }),
      maybeSingle: () => Promise.resolve({ data: read(filters, opts)[0] ?? null, error: null }),
      then: (resolve: (r: { data: StoredRow[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: read(filters, opts), error: null })),
    };
    return builder;
  }

  function updateBuilder(patch: Record<string, unknown>, filters: [string, unknown][]) {
    const apply = () => {
      writes.push(`update ${JSON.stringify(patch)}`);
      for (const r of read(filters, {})) Object.assign(r, patch);
      return Promise.resolve({ data: null, error: null });
    };
    const builder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => updateBuilder(patch, [...filters, [col, val]]),
      then: (resolve: (r: { data: null; error: null }) => unknown) => apply().then(resolve),
    };
    return builder;
  }

  const admin = {
    from: () => ({
      select: () => selectBuilder([], {}),
      update: (patch: Record<string, unknown>) => updateBuilder(patch, []),
      insert: (patch: Record<string, unknown>) => {
        inserts.push(patch);
        writes.push("insert");
        const created = row({ ...(patch as unknown as StoredRow), id: "new" });
        rows.push(created);
        return {
          select: () => ({ single: () => Promise.resolve({ data: created, error: null }) }),
        };
      },
    }),
  };
  return { admin: admin as never, rows, inserts, writes };
}

describe("listWaiverTemplateRows", () => {
  it("parses the acknowledgements JSONB rather than handing it back raw", async () => {
    // The column is JSONB and the generated types call it `Json`, so anything
    // reading it without `parseTemplateAcks` is trusting whatever is in there.
    const { admin } = fakeStore([
      row({ version: 2, acknowledgements: [MEDIA_ACK, { id: "bad" }, "nonsense"] }),
    ]);
    const [first] = await listWaiverTemplateRows(admin);
    expect(first.acknowledgements).toEqual([MEDIA_ACK]);
  });
});

describe("loadWaiverTemplateVersion", () => {
  // The one that would go unnoticed: "live" is the flagged row, not the newest.
  // Answering with the newest has a caller edit and republish a version the club
  // deliberately rolled back from.
  it("reads the flagged live version, not the highest-numbered one", async () => {
    const { admin } = fakeStore([row({ version: 2, is_current: true }), row({ version: 5 })]);
    await expect(loadWaiverTemplateVersion(admin)).resolves.toMatchObject({ version: 2 });
  });

  it("reads a named version, live or not", async () => {
    const { admin } = fakeStore([row({ version: 2, is_current: true }), row({ version: 5 })]);
    await expect(loadWaiverTemplateVersion(admin, 5)).resolves.toMatchObject({
      version: 5,
      is_current: false,
    });
  });

  it("returns null for a version that does not exist", async () => {
    const { admin } = fakeStore([row({ version: 2, is_current: true })]);
    await expect(loadWaiverTemplateVersion(admin, 9)).resolves.toBeNull();
  });
});

describe("saveWaiverTemplateVersion", () => {
  const draft = { title: "Training Waiver", body_md: "Body", acknowledgements: [MEDIA_ACK] };

  it("numbers the next version and publishes it, previous version first", async () => {
    const store = fakeStore([row({ version: 3, is_current: true })]);
    await expect(saveWaiverTemplateVersion(store.admin, draft, "user-1")).resolves.toMatchObject({
      version: 4,
    });
    expect(store.inserts[0]).toMatchObject({ version: 4, is_current: false, created_by: "user-1" });
    // Insert first, THEN the clear/set pair: the other order leaves the club
    // with no live waiver if the insert fails.
    expect(store.writes).toEqual([
      "insert",
      'update {"is_current":false}',
      'update {"is_current":true}',
    ]);
    expect(store.rows.find((r) => r.version === 4)?.is_current).toBe(true);
    expect(store.rows.find((r) => r.version === 3)?.is_current).toBe(false);
  });

  it("records no author when the caller resolves to no auth user", async () => {
    // `created_by` is a real FK to auth.users, and the agent API's break-glass
    // key has no user behind it.
    const store = fakeStore([row({ version: 1, is_current: true })]);
    await saveWaiverTemplateVersion(store.admin, draft, null);
    expect(store.inserts[0]).toMatchObject({ created_by: null });
  });

  it("numbers the first version 1 on an empty table", async () => {
    const store = fakeStore([]);
    await expect(saveWaiverTemplateVersion(store.admin, draft, null)).resolves.toMatchObject({
      version: 1,
    });
  });

  // The check the promote guard already made, moved ahead of the insert. It
  // fired after the row existed before, which left an unwanted draft in the
  // version list every time somebody saved a template missing the media item.
  it("refuses a version with no media consent acknowledgement, writing nothing", async () => {
    const store = fakeStore([row({ version: 3, is_current: true })]);
    await expect(
      saveWaiverTemplateVersion(
        store.admin,
        {
          ...draft,
          acknowledgements: [{ id: "risk", label: "I accept the risks.", required: true }],
        },
        null,
      ),
    ).rejects.toThrow("no media consent acknowledgement");
    expect(store.writes).toEqual([]);
  });

  it("refuses one whose media item has been emptied rather than removed", async () => {
    const store = fakeStore([row({ version: 3, is_current: true })]);
    await expect(
      saveWaiverTemplateVersion(
        store.admin,
        { ...draft, acknowledgements: [{ id: "media", label: "   ", required: false }] },
        null,
      ),
    ).rejects.toThrow("no media consent acknowledgement");
    expect(store.writes).toEqual([]);
  });
});

// The reason on a refusal is what the agent API turns into a status code, and
// getting it wrong is not cosmetic: SKILL.md tells agents a 4xx means the
// request has to change, so an outage reported as one is an outage nobody
// retries. `version` separates "nothing was written" from "version N exists and
// is simply not live", which is the difference between retrying the save and
// finishing with a publish.
describe("WaiverTemplateError reasons", () => {
  async function reasonOf(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (e) {
      expect(e).toBeInstanceOf(WaiverTemplateError);
      const err = e as WaiverTemplateError;
      return { reason: err.reason, version: err.version };
    }
    throw new Error("expected a refusal");
  }

  it("calls a missing version not_found rather than invalid", async () => {
    const { admin } = fakeClient(() => ok(null));
    expect(await reasonOf(() => promoteWaiverTemplate(admin, "gone"))).toEqual({
      reason: "not_found",
      version: undefined,
    });
  });

  it("calls a version missing its media acknowledgement invalid", async () => {
    const { admin } = fakeClient(() =>
      ok({ id: "v2", version: 2, is_current: false, acknowledgements: [] }),
    );
    expect(await reasonOf(() => promoteWaiverTemplate(admin, "v2"))).toEqual({
      reason: "invalid",
      version: 2,
    });
  });

  it("calls a lost promotion race not_published, naming the version left unlive", async () => {
    const { admin } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({
          id: "v2",
          version: 2,
          is_current: false,
          acknowledgements: [{ id: "media", label: "Photos are fine.", required: false }],
        });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      if (op.verb === "select") return ok({ id: "v3" });
      if (op.patch?.is_current === true) return { data: null, error: { message: "conflict" } };
      return ok(null);
    });
    expect(await reasonOf(() => promoteWaiverTemplate(admin, "v2"))).toEqual({
      reason: "not_published",
      version: 2,
    });
  });

  it("calls a refused save invalid, with no version, because nothing was written", async () => {
    const store = fakeStore([row({ version: 3, is_current: true })]);
    expect(
      await reasonOf(() =>
        saveWaiverTemplateVersion(
          store.admin,
          { title: "T", body_md: "B", acknowledgements: [] },
          null,
        ),
      ),
    ).toEqual({ reason: "invalid", version: undefined });
  });

  // The one worth the whole class: the row IS there, so a caller repeating the
  // save files a second copy of the same wording under a new number.
  it("names the version a save wrote but could not publish", async () => {
    const store = fakeStore([row({ version: 3, is_current: true })]);
    const admin = store.admin as unknown as {
      from: (t: string) => { update: (p: Record<string, unknown>) => unknown };
    };
    const realFrom = admin.from;
    admin.from = (table: string) => {
      const built = realFrom(table) as Record<string, unknown>;
      return {
        ...built,
        update: (patch: Record<string, unknown>) =>
          patch.is_current === true
            ? {
                eq: () => ({
                  then: (resolve: (r: { data: null; error: { message: string } }) => unknown) =>
                    Promise.resolve(resolve({ data: null, error: { message: "storage blip" } })),
                }),
              }
            : (built.update as (p: Record<string, unknown>) => unknown)(patch),
      } as never;
    };
    expect(
      await reasonOf(() =>
        saveWaiverTemplateVersion(
          store.admin,
          { title: "T", body_md: "B", acknowledgements: [MEDIA_ACK] },
          null,
        ),
      ),
    ).toEqual({ reason: "not_published", version: 4 });
  });
});
