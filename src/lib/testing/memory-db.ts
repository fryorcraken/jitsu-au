// An in-memory stand-in for the service-role Supabase client, for tests that
// care about OUTCOMES (what the tables hold afterwards) rather than about the
// order of the queries that got there.
//
// It evaluates the filters and orderings the syllabus and knowledge base code
// uses (eq, in, is, not, order, limit, maybeSingle, single, head counts),
// lands inserts, replaces on upsert, and enforces the unique keys below,
// including the "one live version per article" partial index, so a promotion
// that would collide fails here the way it fails in Postgres. Rows come back as
// copies, as they do over PostgREST. Extend it when a test needs a chain it
// lacks; do not loosen what it already checks.
import type { KbClient } from "@/lib/kb-types";

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;
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

export function memoryDb(tables: Tables): KbClient {
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
