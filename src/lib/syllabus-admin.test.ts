// The syllabus's reads and writes, driven against an in-memory database.
//
// A sequence-scripted fake (as `kb-admin.test.ts` uses) would pin the ORDER of
// the queries, and the thing worth pinning here is the outcome: what the belt
// pages say after a save, which pages got a new version and which did not, and
// what a member is allowed to see. So the tables below are real enough to read
// back: filters are evaluated, inserts land, upserts replace, and the article
// version promotion runs exactly as it does against Postgres.
import { describe, expect, it } from "vitest";
import {
  deleteBelt,
  deleteSyllabusTopic,
  loadSyllabus,
  saveBelt,
  saveSyllabusEntries,
  saveSyllabusTopic,
} from "./syllabus-admin";
import { syllabusView } from "./syllabus";
import type { KbClient } from "./kb-types";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Filter = (row: Row) => boolean;

let ids = 0;
const newId = () => `id-${++ids}`;

/** Unique keys the fake enforces, so a duplicate fails as Postgres would. */
const UNIQUE: Record<string, string[][]> = {
  belts: [["slug"]],
  syllabus_topics: [["slug"]],
  syllabus_entries: [["belt_id", "topic_id"]],
  kb_sections: [["slug"]],
  kb_articles: [["slug"], ["belt_id"]],
  kb_article_versions: [["article_id", "version"]],
};

function memoryDb(tables: Tables) {
  const violates = (table: string, row: Row, except?: Row) =>
    (UNIQUE[table] ?? []).some((cols) =>
      (tables[table] ?? []).some(
        (other) =>
          other !== except &&
          cols.every((c) => other[c] !== null && other[c] !== undefined && other[c] === row[c]),
      ),
    ) ||
    // The partial unique index: one live version per article.
    (table === "kb_article_versions" &&
      row.is_current === true &&
      (tables[table] ?? []).some(
        (o) => o !== except && o.article_id === row.article_id && o.is_current === true,
      ));
  const dup = { data: null, error: { message: "duplicate key value", code: "23505" } };

  function query(table: string, verb: string, payload?: unknown, opts?: Row) {
    const filters: Filter[] = [];
    let limit: number | null = null;
    const orderBy: { col: string; asc: boolean }[] = [];
    let head = false;
    let counting = false;
    let returning = verb === "select";

    const rows = () => (tables[table] ??= []);
    const matching = () => rows().filter((r) => filters.every((f) => f(r)));

    const run = (): { data: unknown; error: unknown; count?: number } => {
      if (verb === "insert" || verb === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const written: Row[] = [];
        for (const values of list) {
          const row: Row = { id: newId(), created_at: "now", updated_at: "now", ...values };
          if (verb === "upsert") {
            const keys = String(opts?.onConflict ?? "id").split(",");
            const existing = rows().find((r) => keys.every((k) => r[k] === row[k]));
            if (existing) {
              Object.assign(existing, values);
              written.push(existing);
              continue;
            }
          }
          if (violates(table, row)) return dup;
          rows().push(row);
          written.push(row);
        }
        return { data: returning ? written.map((r) => ({ ...r })) : null, error: null };
      }
      if (verb === "update") {
        const hit = matching();
        for (const row of hit) {
          const next = { ...row, ...(payload as Row) };
          if (violates(table, next, row)) return dup;
        }
        for (const row of hit) Object.assign(row, payload as Row);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (verb === "delete") {
        const hit = new Set(matching());
        tables[table] = rows().filter((r) => !hit.has(r));
        return { data: null, error: null };
      }
      let found = matching();
      for (const { col, asc } of [...orderBy].reverse()) {
        found = [...found].sort((a, b) => {
          const x = a[col] as number | string;
          const y = b[col] as number | string;
          return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      if (limit !== null) found = found.slice(0, limit);
      // Copies, as PostgREST hands back: code that holds a row it read must
      // not see a later write change it underneath.
      found = found.map((r) => ({ ...r }));
      return { data: head ? null : found, error: null, count: counting ? found.length : undefined };
    };

    const single = (allowNone: boolean) => {
      const result = run();
      if (result.error) return Promise.resolve(result);
      const list = (result.data as Row[] | null) ?? [];
      if (list.length > 1) return Promise.resolve({ data: null, error: { message: "many rows" } });
      if (!list.length && !allowNone)
        return Promise.resolve({ data: null, error: { message: "no rows" } });
      return Promise.resolve({ data: list[0] ?? null, error: null });
    };

    const builder: Record<string, unknown> = {
      select: (_cols?: string, sel?: { count?: string; head?: boolean }) => {
        returning = true;
        if (sel?.count) counting = true;
        if (sel?.head) head = true;
        return builder;
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder),
      not: (c: string, _op: string, v: unknown) => (
        filters.push((r) => (r[c] ?? null) !== v),
        builder
      ),
      order: (col: string, o?: { ascending?: boolean }) => (
        orderBy.push({ col, asc: o?.ascending !== false }),
        builder
      ),
      limit: (n: number) => ((limit = n), builder),
      maybeSingle: () => single(true),
      single: () => single(false),
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  const db = {
    from: (table: string) => ({
      select: (cols?: string, sel?: { count?: string; head?: boolean }) =>
        (query(table, "select").select as (c?: string, s?: unknown) => unknown)(cols, sel),
      insert: (values: unknown) => query(table, "insert", values),
      upsert: (values: unknown, opts?: Row) => query(table, "upsert", values, opts),
      update: (patch: Row) => query(table, "update", patch),
      delete: () => query(table, "delete"),
    }),
  };
  return db as unknown as KbClient;
}

/** A club with three belts, a few topics, and yellow's page already written. */
function club(): Tables {
  return {
    belts: [
      { id: "b-white", slug: "white", name: "White", grade: null, colour: "#ffffff", position: 10 },
      {
        id: "b-yellow",
        slug: "yellow",
        name: "Yellow",
        grade: "7th Kyu",
        colour: "#facc15",
        position: 20,
      },
      {
        id: "b-green",
        slug: "green",
        name: "Green",
        grade: "5th Kyu",
        colour: "#16a34a",
        position: 40,
      },
    ],
    syllabus_topics: [
      { id: "t-break", slug: "breakfalling", title: "Breakfalling", parent_id: null, position: 10 },
      { id: "t-tech", slug: "techniques", title: "Techniques", parent_id: null, position: 30 },
      { id: "t-throws", slug: "throws", title: "Throws", parent_id: "t-tech", position: 10 },
      { id: "t-uke", slug: "uke", title: "Uke", parent_id: null, position: 40 },
    ],
    syllabus_entries: [
      { belt_id: "b-yellow", topic_id: "t-break", body_md: "- Peg leg" },
      { belt_id: "b-yellow", topic_id: "t-uke", body_md: "- Open hands" },
    ],
    kb_sections: [
      { id: "s-syl", slug: "syllabus", title: "Syllabus", kind: "syllabus", position: 65 },
    ],
    kb_articles: [
      {
        id: "a-yellow",
        slug: "yellow-belt",
        visibility: "members",
        belt_id: "b-yellow",
        section_id: "s-syl",
        position: 20,
        link_path: null,
      },
    ],
    kb_article_versions: [
      {
        id: "v-yellow-1",
        article_id: "a-yellow",
        version: 1,
        title: "Yellow belt (7th Kyu)",
        // As it was written before the syllabus was structured: no blank lines.
        body_md: "## Breakfalling\n- Peg leg\n\n## Uke\n- Open hands",
        is_current: true,
      },
    ],
  };
}

const live = (tables: Tables, articleId: string) =>
  tables.kb_article_versions.find((v) => v.article_id === articleId && v.is_current);

const member = { userId: "u-member", isManager: false };
const manager = { userId: "u-manager", isManager: true };

describe("saveSyllabusEntries", () => {
  it("saves a block and republishes that belt's page once", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusEntries(
      db,
      {
        entries: [
          { belt: "yellow", topic: "throws", body_md: "- O Goshi" },
          { belt: "yellow", topic: "uke", body_md: "- Open hands\n- Knees" },
        ],
        change_note: "Throws added",
      },
      "u-manager",
    );
    expect(result).toMatchObject({ saved: 2, cleared: 0 });
    expect(result.pages).toEqual([
      { belt: "yellow", page: "yellow-belt", version: 2, created: false },
    ]);
    expect(live(tables, "a-yellow")).toMatchObject({
      version: 2,
      change_note: "Throws added",
      body_md:
        "## Breakfalling\n\n- Peg leg\n\n## Techniques\n\n### Throws\n\n- O Goshi\n\n## Uke\n\n- Open hands\n- Knees",
    });
  });

  it("publishes nothing when the page would say the same thing", async () => {
    const tables = club();
    const db = memoryDb(tables);
    // Resaving yellow's own text: the stored page has no blank lines under its
    // headings and the assembled one does, which must not count as an update.
    const result = await saveSyllabusEntries(
      db,
      { entries: [{ belt: "yellow", topic: "uke", body_md: "- Open hands" }] },
      "u-manager",
    );
    expect(result.pages).toEqual([
      { belt: "yellow", page: "yellow-belt", version: null, created: false },
    ]);
    expect(tables.kb_article_versions).toHaveLength(1);
  });

  it("clears a block when sent empty text", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusEntries(
      db,
      { entries: [{ belt: "yellow", topic: "uke", body_md: "  " }] },
      "u-manager",
    );
    expect(result).toMatchObject({ saved: 0, cleared: 1 });
    expect(live(tables, "a-yellow")?.body_md).toBe("## Breakfalling\n\n- Peg leg");
  });

  it("makes a page for a belt's first block, at managers visibility, in the syllabus section", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusEntries(
      db,
      { entries: [{ belt: "green", topic: "breakfalling", body_md: "- Judo rolls" }] },
      "u-manager",
    );
    expect(result.pages).toEqual([
      { belt: "green", page: "green-belt", version: 1, created: true },
    ]);
    const page = tables.kb_articles.find((a) => a.slug === "green-belt")!;
    expect(page).toMatchObject({
      visibility: "managers",
      belt_id: "b-green",
      section_id: "s-syl",
      position: 40,
    });
    expect(live(tables, page.id as string)).toMatchObject({
      title: "Green belt (5th Kyu)",
      body_md: "## Breakfalling\n\n- Judo rolls",
    });
  });

  it("refuses the whole save, writing nothing, when a belt or topic is unknown", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await expect(
      saveSyllabusEntries(
        db,
        {
          entries: [
            { belt: "yellow", topic: "uke", body_md: "- Changed" },
            { belt: "blue", topic: "weapons", body_md: "- Knife" },
          ],
        },
        "u-manager",
      ),
    ).rejects.toThrow('Nothing was saved: there is no belt "blue", no topic "weapons"');
    expect(tables.syllabus_entries.find((e) => e.topic_id === "t-uke")?.body_md).toBe(
      "- Open hands",
    );
  });
});

describe("loadSyllabus", () => {
  it("hides a belt whose page is managers-only from a member, text and all", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await saveSyllabusEntries(
      db,
      { entries: [{ belt: "green", topic: "breakfalling", body_md: "- Judo rolls" }] },
      "u-manager",
    );

    const forMember = await loadSyllabus(db, member);
    expect(forMember.belts.map((b) => b.slug)).toEqual(["yellow"]);
    expect(forMember.entries.map((e) => e.belt)).not.toContain("green");

    const forManager = await loadSyllabus(db, manager);
    expect(forManager.belts.map((b) => b.slug)).toEqual(["yellow", "green"]);
  });

  it("refuses a signed-out reader everything", async () => {
    const data = await loadSyllabus(memoryDb(club()), { userId: null, isManager: false });
    expect(data.belts).toEqual([]);
    expect(data.entries).toEqual([]);
  });

  it("gives a manager screen every belt, including one with no page", async () => {
    const data = await loadSyllabus(memoryDb(club()));
    expect(data.belts.map((b) => [b.slug, b.page_slug])).toEqual([
      ["white", null],
      ["yellow", "yellow-belt"],
      ["green", null],
    ]);
    expect(syllabusView(data).choices.map((b) => b.slug)).toEqual(["yellow"]);
  });
});

describe("saveSyllabusTopic", () => {
  it("renames a topic and republishes the pages it is on, keeping its anchor", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusTopic(
      db,
      { slug: "breakfalling", title: "Ukemi" },
      "u-manager",
    );
    expect(result.pages).toEqual([
      { belt: "yellow", page: "yellow-belt", version: 2, created: false },
    ]);
    expect(live(tables, "a-yellow")?.body_md).toContain("## Ukemi {#breakfalling}");
    expect(live(tables, "a-yellow")?.change_note).toBe('"Breakfalling" renamed to "Ukemi"');
  });

  it("creates a sub-topic under a topic, after its siblings", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await saveSyllabusTopic(db, { slug: "locks", title: "Locks", parent: "techniques" }, null);
    expect(tables.syllabus_topics.find((t) => t.slug === "locks")).toMatchObject({
      parent_id: "t-tech",
      position: 20,
    });
  });

  it("goes only one level deep", async () => {
    const db = memoryDb(club());
    await expect(
      saveSyllabusTopic(db, { slug: "o-goshi", title: "O Goshi", parent: "throws" }, null),
    ).rejects.toThrow(/only one level deep/);
    await expect(
      saveSyllabusTopic(db, { slug: "techniques", parent: "uke" }, null),
    ).rejects.toThrow(/has sub-topics of its own/);
  });

  it("refuses to create a topic that already exists when told it is new", async () => {
    await expect(
      saveSyllabusTopic(memoryDb(club()), { slug: "uke", title: "Uke", expect_new: true }, null),
    ).rejects.toThrow(/already a topic/);
  });
});

describe("deleteSyllabusTopic", () => {
  it("refuses while a belt still has text on it, naming the belt", async () => {
    await expect(deleteSyllabusTopic(memoryDb(club()), "uke")).rejects.toThrow(
      '"Uke" still has text for Yellow',
    );
  });

  it("refuses while it has sub-topics", async () => {
    await expect(deleteSyllabusTopic(memoryDb(club()), "techniques")).rejects.toThrow(/sub-topics/);
  });

  it("deletes an unused topic", async () => {
    const tables = club();
    await deleteSyllabusTopic(memoryDb(tables), "throws");
    expect(tables.syllabus_topics.map((t) => t.slug)).not.toContain("throws");
  });
});

describe("saveBelt", () => {
  it("retitles the page when the grade changes", async () => {
    const tables = club();
    const result = await saveBelt(memoryDb(tables), { slug: "yellow", grade: "8th Kyu" }, null);
    expect(result.pages[0]).toMatchObject({ version: 2 });
    expect(live(tables, "a-yellow")?.title).toBe("Yellow belt (8th Kyu)");
  });

  it("moves the page with the belt, without publishing a version", async () => {
    const tables = club();
    const result = await saveBelt(memoryDb(tables), { slug: "yellow", position: 25 }, null);
    expect(result.pages).toEqual([]);
    expect(tables.kb_articles[0].position).toBe(25);
    expect(tables.kb_article_versions).toHaveLength(1);
  });

  it("creates a belt at the end, and needs a name and colour to do it", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await expect(saveBelt(db, { slug: "black" }, null)).rejects.toThrow(
      /needs a name and a colour/,
    );
    await saveBelt(db, { slug: "black", name: "Black", colour: "#000000" }, null);
    expect(tables.belts.find((b) => b.slug === "black")).toMatchObject({
      position: 50,
      grade: null,
    });
  });
});

describe("deleteBelt", () => {
  it("refuses a belt with a page", async () => {
    await expect(deleteBelt(memoryDb(club()), "yellow")).rejects.toThrow(/has a syllabus page/);
  });

  it("deletes a belt with nothing attached", async () => {
    const tables = club();
    await deleteBelt(memoryDb(tables), "white");
    expect(tables.belts.map((b) => b.slug)).toEqual(["yellow", "green"]);
  });
});
