// Saving and publishing club documents, driven against a fake client.
//
// `saveDocument` and `promoteDocumentVersion` take their client as a parameter
// for the same reason `promoteWaiverTemplate` does: a `createServerFn` handler
// dies in the runner on "No Start context found in AsyncLocalStorage". The
// harness below is the one in `waiver-template.functions.test.ts`, widened to
// record the TABLE each operation hit — which is the whole point here, since the
// difference between this promotion and the waiver's is that every write must be
// scoped to one document.
import { describe, expect, it } from "vitest";
import { listSharedAnnotations, promoteDocumentVersion, saveDocument } from "./document-admin";
import type { DocumentClient } from "./document-types";
import type { SaveDocumentInput } from "./validation";

type Result = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

type Op = {
  table: string;
  verb: "select" | "update" | "insert";
  patch?: Record<string, unknown>;
  values?: Record<string, unknown>;
  filters: [string, unknown][];
  limit?: number;
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
      in: (col: string, val: unknown) => (op.filters.push([col, val]), builder),
      is: (col: string, val: unknown) => (op.filters.push([col, val]), builder),
      order: () => builder,
      limit: (n: number) => ((op.limit = n), builder),
      select: () => builder,
      maybeSingle: () => settle(),
      single: () => settle(),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return builder;
  }
  const db = {
    from: (table: string) => ({
      select: () => chain({ table, verb: "select", filters: [] }),
      update: (patch: Record<string, unknown>) =>
        chain({ table, verb: "update", patch, filters: [] }),
      insert: (values: Record<string, unknown>) =>
        chain({ table, verb: "insert", values, filters: [] }),
    }),
  };
  return { db: db as unknown as DocumentClient, calls };
}

const writes = (calls: Op[]) => calls.filter((c) => c.verb !== "select");
const inserts = (calls: Op[], table: string) =>
  calls.filter((c) => c.verb === "insert" && c.table === table);
/** The write that unpublishes a version, i.e. the one that opens the gap. */
const clears = (calls: Op[]) =>
  calls.filter((c) => c.verb === "update" && c.patch?.is_current === false);

describe("promoteDocumentVersion", () => {
  it("clears the old live version before setting the new one", async () => {
    const { db, calls } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false, document_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      return ok(null);
    });
    await expect(promoteDocumentVersion(db, "v2")).resolves.toEqual({ version: 2 });
    const updates = calls.filter((c) => c.verb === "update");
    expect(updates[0].patch).toEqual({ is_current: false });
    expect(updates[1].patch).toEqual({ is_current: true });
    expect(updates[1].filters).toContainEqual(["id", "v2"]);
  });

  // The difference from the waiver's single global template, and the bug worth
  // ruling out: an unscoped clear would unpublish every OTHER document too.
  it("scopes the clear to the target's own document", async () => {
    const { db, calls } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false, document_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      return ok(null);
    });
    await promoteDocumentVersion(db, "v2");
    for (const clear of clears(calls)) {
      expect(clear.filters).toContainEqual(["document_id", "doc-1"]);
    }
  });

  it("refuses an unknown version without unpublishing anything", async () => {
    const { db, calls } = fakeClient(() => ok(null));
    await expect(promoteDocumentVersion(db, "gone")).rejects.toThrow("no longer exists");
    expect(clears(calls)).toHaveLength(0);
  });

  it("does nothing when the target is already live", async () => {
    const { db, calls } = fakeClient(() =>
      ok({ id: "v2", version: 2, is_current: true, document_id: "doc-1" }),
    );
    await expect(promoteDocumentVersion(db, "v2")).resolves.toEqual({ version: 2 });
    expect(writes(calls)).toHaveLength(0);
  });

  it("reports a concurrent publish as a race rather than a database error", async () => {
    const { db } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false, document_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      // The post-failure re-read finds something live: somebody else won.
      if (op.verb === "select") return ok({ id: "v3" });
      if (op.patch?.is_current === true) return { data: null, error: { message: "unique" } };
      return ok(null);
    });
    await expect(promoteDocumentVersion(db, "v2")).rejects.toThrow(/Someone else published/);
  });

  it("puts the previous version back when the promotion fails", async () => {
    const { db, calls } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false, document_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      if (op.verb === "select") return ok(null);
      if (op.patch?.is_current === true && op.filters.some(([, v]) => v === "v2"))
        return { data: null, error: { message: "boom" } };
      return ok(null);
    });
    await expect(promoteDocumentVersion(db, "v2")).rejects.toThrow("boom");
    const restore = calls.filter(
      (c) => c.patch?.is_current === true && c.filters.some(([, v]) => v === "v1"),
    );
    expect(restore).toHaveLength(1);
  });
});

const baseInput: SaveDocumentInput = {
  slug: "house-rules",
  title: "House rules",
  body_md: "# Rules",
};

/**
 * Respond as a database where the document may or may not already exist, with
 * `maxVersion` versions behind it.
 */
function saveHarness(opts: { existing: Record<string, unknown> | null; maxVersion: number }) {
  return fakeClient((op) => {
    if (op.table === "documents" && op.verb === "select") return ok(opts.existing);
    if (op.table === "documents" && op.verb === "insert")
      return ok({ id: "doc-1", slug: baseInput.slug, ...op.values });
    if (op.table === "documents" && op.verb === "update")
      return ok({ id: "doc-1", slug: baseInput.slug, ...opts.existing, ...op.patch });
    if (op.table === "document_versions" && op.verb === "select") {
      // Two different selects hit this table: the max-version lookup, then
      // `promoteDocumentVersion`'s own reads. Distinguish by filter shape.
      if (op.filters.some(([col]) => col === "id"))
        return ok({
          id: "ver-new",
          version: opts.maxVersion + 1,
          is_current: false,
          document_id: "doc-1",
        });
      if (op.filters.some(([col]) => col === "is_current")) return ok(null);
      return ok(opts.maxVersion ? { version: opts.maxVersion } : null);
    }
    if (op.table === "document_versions" && op.verb === "insert")
      return ok({ id: "ver-new", version: opts.maxVersion + 1 });
    return ok(null);
  });
}

describe("saveDocument", () => {
  it("creates the document when the slug is new, then publishes version 1", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    const res = await saveDocument(db, baseInput, "11111111-1111-4111-8111-111111111111");
    expect(res).toMatchObject({ slug: "house-rules", version: 1, created: true });
    expect(inserts(calls, "documents")).toHaveLength(1);
    expect(inserts(calls, "document_versions")[0].values).toMatchObject({ version: 1 });
  });

  it("defaults a brand-new document to members-only", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    await saveDocument(db, baseInput, null);
    expect(inserts(calls, "documents")[0].values).toMatchObject({
      visibility: "members",
      annotations_enabled: true,
    });
  });

  it("adds the next version to an existing document rather than editing in place", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "members" };
    const { db, calls } = saveHarness({ existing, maxVersion: 4 });
    const res = await saveDocument(db, baseInput, null);
    expect(res).toMatchObject({ version: 5, created: false });
    expect(inserts(calls, "documents")).toHaveLength(0);
    expect(inserts(calls, "document_versions")[0].values).toMatchObject({ version: 5 });
  });

  // An agent editing the text of a managers-only draft must not publish it to
  // the world by simply not mentioning visibility.
  it("leaves visibility alone when the save does not mention it", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "managers" };
    const { db, calls } = saveHarness({ existing, maxVersion: 1 });
    await saveDocument(db, baseInput, null);
    const patch = calls.find((c) => c.table === "documents" && c.verb === "update")?.patch ?? {};
    expect(patch).not.toHaveProperty("visibility");
    expect(patch).not.toHaveProperty("annotations_enabled");
  });

  it("applies visibility when the save does mention it", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "managers" };
    const { db, calls } = saveHarness({ existing, maxVersion: 1 });
    await saveDocument(db, { ...baseInput, visibility: "public" }, null);
    const patch = calls.find((c) => c.table === "documents" && c.verb === "update")?.patch ?? {};
    expect(patch).toMatchObject({ visibility: "public" });
  });

  // The version row is written as a draft and promoted afterwards, so a failed
  // insert leaves the previously published version untouched.
  it("inserts the new version unpublished, then promotes it", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    await saveDocument(db, baseInput, null);
    expect(inserts(calls, "document_versions")[0].values).toMatchObject({ is_current: false });
    const promote = calls.filter((c) => c.verb === "update" && c.patch?.is_current === true);
    expect(promote).toHaveLength(1);
  });

  // The break-glass agent key authenticates as a non-UUID sentinel with no auth
  // user behind it; writing it into a `references auth.users` column fails the
  // insert outright.
  it("records no author when the actor is not a real user id", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    await saveDocument(db, baseInput, "manager-agent-env-key");
    expect(inserts(calls, "documents")[0].values).toMatchObject({ created_by: null });
    expect(inserts(calls, "document_versions")[0].values).toMatchObject({ created_by: null });
  });
});

/**
 * The privacy filter, which is the reason this function takes its client as a
 * parameter at all.
 *
 * The fake client does not evaluate filters — it hands back whatever the test
 * says — so what is asserted here is the QUERY: that every read of members'
 * annotations carries `visibility = shared`. That is the whole guarantee. A
 * manager screen or the agent API reading this without that filter would hand
 * over private notes, and nothing downstream would catch it, because a private
 * row looks exactly like a shared one once it has been returned.
 */
describe("listSharedAnnotations", () => {
  const rows = [
    { id: "a1", visibility: "shared", body: "Can we soften this?" },
    { id: "a2", visibility: "shared", body: "Agreed." },
  ];

  it("asks only for shared annotations on the one document", async () => {
    const { db, calls } = fakeClient(() => ok(rows));
    const out = await listSharedAnnotations(db, "doc-1", { limit: 200 });
    expect(out).toEqual(rows);
    const [read] = calls;
    expect(read.table).toBe("document_annotations");
    expect(read.filters).toContainEqual(["visibility", "shared"]);
    expect(read.filters).toContainEqual(["document_id", "doc-1"]);
  });

  // Belt and braces: no argument to this function can widen the read to
  // private notes, so there is nothing a caller could pass to leak them.
  it("keeps the shared filter when resolved threads are included", async () => {
    const { db, calls } = fakeClient(() => ok(rows));
    await listSharedAnnotations(db, "doc-1", { includeResolved: true, limit: 200 });
    expect(calls[0].filters).toContainEqual(["visibility", "shared"]);
    expect(calls[0].filters).not.toContainEqual(["resolved_at", null]);
  });

  it("hides resolved threads unless they are asked for", async () => {
    const { db, calls } = fakeClient(() => ok(rows));
    await listSharedAnnotations(db, "doc-1", { limit: 200 });
    expect(calls[0].filters).toContainEqual(["resolved_at", null]);
  });

  it("passes the caller's cap through to the query", async () => {
    const { db, calls } = fakeClient(() => ok(rows));
    await listSharedAnnotations(db, "doc-1", { limit: 25 });
    expect(calls[0].limit).toBe(25);
  });

  it("gives back an empty list rather than null when there is nothing", async () => {
    const { db } = fakeClient(() => ok(null));
    await expect(listSharedAnnotations(db, "doc-1", { limit: 200 })).resolves.toEqual([]);
  });

  it("surfaces a failed read instead of reporting no comments", async () => {
    const { db } = fakeClient(() => ({ data: null, error: { message: "boom" } }));
    await expect(listSharedAnnotations(db, "doc-1", { limit: 200 })).rejects.toThrow("boom");
  });
});
