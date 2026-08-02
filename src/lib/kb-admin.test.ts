// Saving and publishing knowledge base articles, driven against a fake client.
//
// `saveKbArticle` and `promoteArticleVersion` take their client as a parameter
// for the same reason `promoteWaiverTemplate` does: a `createServerFn` handler
// dies in the runner on "No Start context found in AsyncLocalStorage". The
// harness below is the one in `waiver-template.functions.test.ts`, widened to
// record the TABLE each operation hit — which is the whole point here, since the
// difference between this promotion and the waiver's is that every write must be
// scoped to one article.
import { describe, expect, it } from "vitest";
import {
  listSharedAnnotations,
  promoteArticleVersion,
  saveKbArticle,
  saveKbSection,
} from "./kb-admin";
import type { KbClient } from "./kb-types";
import type { SaveKbArticleInput } from "./validation";

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

function fakeClient(respond: (op: Op, calls: Op[]) => Result, count?: number) {
  const calls: Op[] = [];
  function chain(op: Op) {
    const settle = () => {
      calls.push(op);
      // `count` rides along on every result, as PostgREST does for a head
      // count query. Only the link-entry guard reads it.
      return Promise.resolve({ count, ...respond(op, calls) });
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
  return { db: db as unknown as KbClient, calls };
}

const writes = (calls: Op[]) => calls.filter((c) => c.verb !== "select");
const inserts = (calls: Op[], table: string) =>
  calls.filter((c) => c.verb === "insert" && c.table === table);
/** The write that unpublishes a version, i.e. the one that opens the gap. */
const clears = (calls: Op[]) =>
  calls.filter((c) => c.verb === "update" && c.patch?.is_current === false);

describe("promoteArticleVersion", () => {
  it("clears the old live version before setting the new one", async () => {
    const { db, calls } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false, article_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      return ok(null);
    });
    await expect(promoteArticleVersion(db, "v2")).resolves.toEqual({ version: 2 });
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
        return ok({ id: "v2", version: 2, is_current: false, article_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      return ok(null);
    });
    await promoteArticleVersion(db, "v2");
    for (const clear of clears(calls)) {
      expect(clear.filters).toContainEqual(["article_id", "doc-1"]);
    }
  });

  it("refuses an unknown version without unpublishing anything", async () => {
    const { db, calls } = fakeClient(() => ok(null));
    await expect(promoteArticleVersion(db, "gone")).rejects.toThrow("no longer exists");
    expect(clears(calls)).toHaveLength(0);
  });

  it("does nothing when the target is already live", async () => {
    const { db, calls } = fakeClient(() =>
      ok({ id: "v2", version: 2, is_current: true, article_id: "doc-1" }),
    );
    await expect(promoteArticleVersion(db, "v2")).resolves.toEqual({ version: 2 });
    expect(writes(calls)).toHaveLength(0);
  });

  it("reports a concurrent publish as a race rather than a database error", async () => {
    const { db } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false, article_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      // The post-failure re-read finds something live: somebody else won.
      if (op.verb === "select") return ok({ id: "v3" });
      if (op.patch?.is_current === true) return { data: null, error: { message: "unique" } };
      return ok(null);
    });
    await expect(promoteArticleVersion(db, "v2")).rejects.toThrow(/Someone else published/);
  });

  it("puts the previous version back when the promotion fails", async () => {
    const { db, calls } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false, article_id: "doc-1" });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      if (op.verb === "select") return ok(null);
      if (op.patch?.is_current === true && op.filters.some(([, v]) => v === "v2"))
        return { data: null, error: { message: "boom" } };
      return ok(null);
    });
    await expect(promoteArticleVersion(db, "v2")).rejects.toThrow("boom");
    const restore = calls.filter(
      (c) => c.patch?.is_current === true && c.filters.some(([, v]) => v === "v1"),
    );
    expect(restore).toHaveLength(1);
  });
});

const baseInput: SaveKbArticleInput = {
  slug: "house-rules",
  title: "House rules",
  body_md: "# Rules",
};

/**
 * Respond as a database where the document may or may not already exist, with
 * `maxVersion` versions behind it.
 */
function saveHarness(opts: {
  existing: Record<string, unknown> | null;
  maxVersion: number;
  /** Section slugs the club has, so a save can be told to file an article. */
  sections?: string[];
  /** How many versions the article already has, for the link-entry guard. */
  versionCount?: number;
}) {
  return fakeClient((op) => {
    if (op.table === "kb_sections" && op.verb === "select") {
      const wanted = op.filters.find(([col]) => col === "slug")?.[1];
      return (opts.sections ?? []).includes(String(wanted))
        ? ok({ id: `sec-${wanted}`, slug: wanted, title: String(wanted), position: 0 })
        : ok(null);
    }
    if (op.table === "kb_articles" && op.verb === "select") return ok(opts.existing);
    if (op.table === "kb_articles" && op.verb === "insert")
      return ok({ id: "doc-1", slug: baseInput.slug, ...op.values });
    if (op.table === "kb_articles" && op.verb === "update")
      return ok({ id: "doc-1", slug: baseInput.slug, ...opts.existing, ...op.patch });
    if (op.table === "kb_article_versions" && op.verb === "select") {
      // Two different selects hit this table: the max-version lookup, then
      // `promoteArticleVersion`'s own reads. Distinguish by filter shape.
      if (op.filters.some(([col]) => col === "id"))
        return ok({
          id: "ver-new",
          version: opts.maxVersion + 1,
          is_current: false,
          article_id: "doc-1",
        });
      if (op.filters.some(([col]) => col === "is_current")) return ok(null);
      return ok(opts.maxVersion ? { version: opts.maxVersion } : null);
    }
    if (op.table === "kb_article_versions" && op.verb === "insert")
      return ok({ id: "ver-new", version: opts.maxVersion + 1 });
    return ok(null);
  }, opts.versionCount);
}

describe("saveKbArticle", () => {
  it("creates the document when the slug is new, then publishes version 1", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    const res = await saveKbArticle(db, baseInput, "11111111-1111-4111-8111-111111111111");
    expect(res).toMatchObject({ slug: "house-rules", version: 1, created: true });
    expect(inserts(calls, "kb_articles")).toHaveLength(1);
    expect(inserts(calls, "kb_article_versions")[0].values).toMatchObject({ version: 1 });
  });

  it("defaults a brand-new document to members-only", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    await saveKbArticle(db, baseInput, null);
    expect(inserts(calls, "kb_articles")[0].values).toMatchObject({
      visibility: "members",
      annotations_enabled: true,
    });
  });

  it("adds the next version to an existing document rather than editing in place", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "members" };
    const { db, calls } = saveHarness({ existing, maxVersion: 4 });
    const res = await saveKbArticle(db, baseInput, null);
    expect(res).toMatchObject({ version: 5, created: false });
    expect(inserts(calls, "kb_articles")).toHaveLength(0);
    expect(inserts(calls, "kb_article_versions")[0].values).toMatchObject({ version: 5 });
  });

  // An agent editing the text of a managers-only draft must not publish it to
  // the world by simply not mentioning visibility.
  it("leaves visibility alone when the save does not mention it", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "managers" };
    const { db, calls } = saveHarness({ existing, maxVersion: 1 });
    await saveKbArticle(db, baseInput, null);
    const patch = calls.find((c) => c.table === "kb_articles" && c.verb === "update")?.patch ?? {};
    expect(patch).not.toHaveProperty("visibility");
    expect(patch).not.toHaveProperty("annotations_enabled");
  });

  it("applies visibility when the save does mention it", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "managers" };
    const { db, calls } = saveHarness({ existing, maxVersion: 1 });
    await saveKbArticle(db, { ...baseInput, visibility: "public" }, null);
    const patch = calls.find((c) => c.table === "kb_articles" && c.verb === "update")?.patch ?? {};
    expect(patch).toMatchObject({ visibility: "public" });
  });

  // The version row is written as a draft and promoted afterwards, so a failed
  // insert leaves the previously published version untouched.
  it("inserts the new version unpublished, then promotes it", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    await saveKbArticle(db, baseInput, null);
    expect(inserts(calls, "kb_article_versions")[0].values).toMatchObject({ is_current: false });
    const promote = calls.filter((c) => c.verb === "update" && c.patch?.is_current === true);
    expect(promote).toHaveLength(1);
  });

  // The break-glass agent key authenticates as a non-UUID sentinel with no auth
  // user behind it; writing it into a `references auth.users` column fails the
  // insert outright.
  it("records no author when the actor is not a real user id", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    await saveKbArticle(db, baseInput, "manager-agent-env-key");
    expect(inserts(calls, "kb_articles")[0].values).toMatchObject({ created_by: null });
    expect(inserts(calls, "kb_article_versions")[0].values).toMatchObject({ created_by: null });
  });
  it("does not touch visibility when a widening save's version insert fails", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "managers" };
    const { db, calls } = fakeClient((op) => {
      if (op.table === "kb_article_versions" && op.verb === "insert")
        return { data: null, error: { message: "boom" } };
      if (op.table === "kb_articles" && op.verb === "select") return ok(existing);
      if (op.table === "kb_articles" && op.verb === "update")
        return ok({ ...existing, ...op.patch });
      return ok(null);
    });
    await expect(saveKbArticle(db, { ...baseInput, visibility: "public" }, null)).rejects.toThrow(
      "boom",
    );
    expect(calls.filter((c) => c.table === "kb_articles" && c.verb === "update")).toHaveLength(0);
  });

  /**
   * NARROWING patches first, and this is the other half of the same rule.
   *
   * Taking a public page to managers-only is usually done because the new text
   * is not for everyone. Patching last would publish that text to the audience
   * it was being taken away from if the patch then failed, while telling the
   * caller the save had not happened.
   */
  it("narrows visibility before the new text can go live", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "public" };
    const { db, calls } = saveHarness({ existing, maxVersion: 1 });
    await saveKbArticle(db, { ...baseInput, visibility: "managers" }, null);
    const patchAt = calls.findIndex((c) => c.table === "kb_articles" && c.verb === "update");
    const insertAt = calls.findIndex(
      (c) => c.table === "kb_article_versions" && c.verb === "insert",
    );
    expect(patchAt).toBeGreaterThanOrEqual(0);
    expect(patchAt).toBeLessThan(insertAt);
  });

  it("widens visibility only after the new text is live", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "managers" };
    const { db, calls } = saveHarness({ existing, maxVersion: 1 });
    await saveKbArticle(db, { ...baseInput, visibility: "public" }, null);
    const patchAt = calls.findIndex((c) => c.table === "kb_articles" && c.verb === "update");
    const promoteAt = calls.findIndex((c) => c.verb === "update" && c.patch?.is_current === true);
    expect(promoteAt).toBeGreaterThanOrEqual(0);
    expect(patchAt).toBeGreaterThan(promoteAt);
  });

  /**
   * The create-versus-update race. The web editor checks its own list of
   * articles first, but that list is a snapshot: another manager, or the agent
   * API, can take the slug between it loading and this save. Without this the
   * save silently becomes an update — a new version over somebody else's page,
   * with its visibility patched to whatever this caller had selected.
   */
  it("refuses a save that expected to create an article whose slug is taken", async () => {
    const existing = { id: "doc-1", slug: "house-rules", visibility: "managers" };
    const { db, calls } = saveHarness({ existing, maxVersion: 3 });
    await expect(
      saveKbArticle(db, { ...baseInput, visibility: "public", expect_new: true }, null),
    ).rejects.toThrow(/already exists/);
    expect(writes(calls)).toHaveLength(0);
  });

  it("still creates when the slug really is free and the caller expected to", async () => {
    const { db } = saveHarness({ existing: null, maxVersion: 0 });
    await expect(
      saveKbArticle(db, { ...baseInput, expect_new: true }, null),
    ).resolves.toMatchObject({ created: true, version: 1 });
  });

  // The break-glass agent key authenticates as a non-UUID sentinel with no auth
  // user behind it; writing it into a `references auth.users` column fails the
  // insert outright.
  it("records no author when the actor is not a real user id", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0 });
    await saveKbArticle(db, baseInput, "manager-agent-env-key");
    expect(inserts(calls, "kb_articles")[0].values).toMatchObject({ created_by: null });
    expect(inserts(calls, "kb_article_versions")[0].values).toMatchObject({ created_by: null });
  });
});

// ---- Sections and placement ----
//
// The order a manager sets IS the onboarding path, so the rules that protect it
// are worth pinning: a save must not move an article it was not asked to move,
// and a mistyped section must not quietly drop one out of the sidebar.
describe("saveKbArticle placement", () => {
  const placed = { id: "doc-1", slug: "house-rules", visibility: "members" };

  it("files an article into a named section", async () => {
    const { db, calls } = saveHarness({
      existing: placed,
      maxVersion: 1,
      sections: ["start-here"],
    });
    await saveKbArticle(db, { ...baseInput, section: "start-here", position: 20 }, null);
    const patch = calls.find((c) => c.table === "kb_articles" && c.verb === "update")?.patch ?? {};
    expect(patch).toMatchObject({ section_id: "sec-start-here", position: 20 });
  });

  it("leaves the placement alone when the save does not mention it", async () => {
    const { db, calls } = saveHarness({ existing: placed, maxVersion: 1 });
    await saveKbArticle(db, baseInput, null);
    const patch = calls.find((c) => c.table === "kb_articles" && c.verb === "update")?.patch ?? {};
    expect(patch).not.toHaveProperty("section_id");
    expect(patch).not.toHaveProperty("position");
  });

  // Silently dropping the article into "Everything else" would be invisible
  // until somebody noticed it had gone missing from its group.
  it("refuses an unknown section rather than unfiling the article", async () => {
    const { db, calls } = saveHarness({
      existing: placed,
      maxVersion: 1,
      sections: ["start-here"],
    });
    await expect(saveKbArticle(db, { ...baseInput, section: "start-her" }, null)).rejects.toThrow(
      /no section "start-her"/,
    );
    expect(writes(calls)).toHaveLength(0);
  });

  it("takes an empty section as a deliberate move out of every section", async () => {
    const { db, calls } = saveHarness({ existing: placed, maxVersion: 1 });
    await saveKbArticle(db, { ...baseInput, section: "" }, null);
    const patch = calls.find((c) => c.table === "kb_articles" && c.verb === "update")?.patch ?? {};
    expect(patch).toMatchObject({ section_id: null });
  });

  // Moving an article is not republishing it: a new version would show every
  // reader "updated today" and a change note nobody wrote.
  it("writes no new version when the save carries no text", async () => {
    const { db, calls } = saveHarness({ existing: placed, maxVersion: 3, sections: ["belts"] });
    const res = await saveKbArticle(db, { slug: "house-rules", section: "belts" }, null);
    expect(res).toMatchObject({ version: null, created: false });
    expect(inserts(calls, "kb_article_versions")).toHaveLength(0);
  });
});

describe("saveKbArticle link entries", () => {
  const link = {
    slug: "your-first-session",
    link_path: "/first-class",
    nav_title: "Your first session",
  };

  it("creates a link entry with no version behind it", async () => {
    const { db, calls } = saveHarness({ existing: null, maxVersion: 0, sections: ["start-here"] });
    const res = await saveKbArticle(db, { ...link, section: "start-here", position: 10 }, null);
    expect(res).toMatchObject({ version: null, created: true });
    expect(inserts(calls, "kb_article_versions")).toHaveLength(0);
    expect(inserts(calls, "kb_articles")[0].values).toMatchObject({
      link_path: "/first-class",
      nav_title: "Your first session",
      // A link entry holds no text here, so there is nothing to anchor a
      // comment to.
      annotations_enabled: false,
    });
  });

  it("refuses to give an existing link entry article text", async () => {
    const existing = { id: "doc-1", slug: "your-first-session", link_path: "/first-class" };
    const { db, calls } = saveHarness({ existing, maxVersion: 0 });
    await expect(
      saveKbArticle(db, { ...baseInput, slug: "your-first-session" }, null),
    ).rejects.toThrow(/is a link to \/first-class/);
    expect(writes(calls)).toHaveLength(0);
  });

  // The other direction: an article people have commented on must not become a
  // signpost, which would strand every comment on text no longer served here.
  it("refuses to turn an article that already has versions into a link", async () => {
    const existing = { id: "doc-1", slug: "our-history", link_path: null };
    const { db } = saveHarness({ existing, maxVersion: 2, versionCount: 2 });
    await expect(
      saveKbArticle(db, { slug: "our-history", link_path: "/about", nav_title: "About" }, null),
    ).rejects.toThrow(/cannot become a link/);
  });

  it("refuses to create an entry that is neither an article nor a link", async () => {
    const { db } = saveHarness({ existing: null, maxVersion: 0 });
    await expect(saveKbArticle(db, { slug: "empty" }, null)).rejects.toThrow(
      /needs a title and body_md, or a link_path/,
    );
  });
});

describe("saveKbSection", () => {
  function sectionHarness(existing: Record<string, unknown> | null) {
    return fakeClient((op) => {
      if (op.table === "kb_sections" && op.verb === "select") return ok(existing);
      return ok(null);
    });
  }

  it("creates a section the club does not have yet", async () => {
    const { db, calls } = sectionHarness(null);
    const res = await saveKbSection(db, { slug: "start-here", title: "Start here", position: 10 });
    expect(res).toEqual({ slug: "start-here", created: true });
    expect(inserts(calls, "kb_sections")[0].values).toMatchObject({
      slug: "start-here",
      title: "Start here",
      position: 10,
    });
  });

  it("needs a title to create one, since there is no version to borrow from", async () => {
    const { db, calls } = sectionHarness(null);
    await expect(saveKbSection(db, { slug: "start-here" })).rejects.toThrow(/needs a title/);
    expect(writes(calls)).toHaveLength(0);
  });

  it("moves a section without renaming it", async () => {
    const { db, calls } = sectionHarness({
      id: "sec-1",
      slug: "belts",
      title: "Belts",
      position: 20,
    });
    const res = await saveKbSection(db, { slug: "belts", position: 30 });
    expect(res).toEqual({ slug: "belts", created: false });
    const patch = calls.find((c) => c.verb === "update")?.patch ?? {};
    expect(patch).toMatchObject({ position: 30 });
    expect(patch).not.toHaveProperty("title");
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

  it("asks only for shared annotations on the one article", async () => {
    const { db, calls } = fakeClient(() => ok(rows));
    const out = await listSharedAnnotations(db, "doc-1", { limit: 200 });
    expect(out).toEqual(rows);
    const [read] = calls;
    expect(read.table).toBe("kb_annotations");
    expect(read.filters).toContainEqual(["visibility", "shared"]);
    expect(read.filters).toContainEqual(["article_id", "doc-1"]);
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

  // The agent API filters by version through this, rather than keeping its own
  // copy of the query. A second copy is a second place the shared-only filter
  // can be dropped without a test noticing.
  it("can narrow to one version without loosening the shared filter", async () => {
    const { db, calls } = fakeClient(() => ok(rows));
    await listSharedAnnotations(db, "doc-1", { version: 3, limit: 200 });
    expect(calls[0].filters).toContainEqual(["article_version", 3]);
    expect(calls[0].filters).toContainEqual(["visibility", "shared"]);
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
