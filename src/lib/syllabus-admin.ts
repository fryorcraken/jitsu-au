// Reading and writing the syllabus, with the client passed in.
//
// One module for the manager screen, the member's page and the agent API, so
// the three cannot disagree about what saving a block does or which belts a
// reader may see (the rule in docs/manager-agent-api.md, "The screens and the
// API report the same thing"). Taking the client as a parameter is also what
// makes it testable: a `createServerFn` handler cannot run in the test runner.
//
// The thing to know before changing anything here: a belt's knowledge base
// page is ASSEMBLED from its blocks and published as an ordinary article
// version (`republishBeltPages`). Every write that can change what a belt page
// says ends by republishing the pages it touched, and a republish that would
// say the same thing block for block writes nothing, so a retry or a save that
// changed nothing never tells a reader a page was updated.
import { canReadArticle } from "@/lib/kb";
import type { Viewer } from "@/lib/kb";
import { writeArticleVersion } from "@/lib/kb-admin";
import type { KbArticleRow, KbClient } from "@/lib/kb-types";
import type { Database } from "@/integrations/supabase/types";
import {
  beltPageSlug,
  beltPageTitle,
  composeBeltPage,
  orderBelts,
  sameBlocks,
  sameBlockSet,
  tidyBlock,
  type SyllabusBelt,
  type SyllabusData,
  type SyllabusEntry,
  type SyllabusTopic,
} from "@/lib/syllabus";
import type {
  ReorderSyllabusTopicsInput,
  SaveBeltInput,
  SaveSyllabusEntriesInput,
  SaveSyllabusTopicInput,
} from "@/lib/validation";

type Tables = Database["public"]["Tables"];
export type BeltRow = Tables["belts"]["Row"];
export type SyllabusTopicRow = Tables["syllabus_topics"]["Row"];
export type SyllabusEntryRow = Tables["syllabus_entries"]["Row"];

/** What a belt page is, as far as the syllabus needs to know. */
type BeltPageRow = Pick<KbArticleRow, "id" | "slug" | "visibility" | "belt_id">;
type EntryListRow = Pick<SyllabusEntryRow, "belt_id" | "topic_id" | "body_md" | "updated_at">;

/** The slug the syllabus section is created under when there is none yet. */
export const SYLLABUS_SECTION_SLUG = "syllabus";

/**
 * More blocks than this and the read is refused rather than truncated: a
 * syllabus missing some of its text because a row cap cut it off would read as
 * complete. Ten belts by thirty topics is three hundred; this is far past it.
 */
const ENTRIES_LIMIT = 5000;

/** A failure a caller should show as it is: a refusal, in words. */
export class SyllabusError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "invalid" | "not_published",
  ) {
    super(message);
    this.name = "SyllabusError";
  }
}

/** Every row the syllabus is made of, read at once. */
export async function loadSyllabusRows(db: KbClient) {
  const [beltsResult, topicsResult, entriesResult, pagesResult] = await Promise.all([
    db.from("belts").select("*"),
    db.from("syllabus_topics").select("*"),
    db
      .from("syllabus_entries")
      .select("belt_id, topic_id, body_md, updated_at")
      .limit(ENTRIES_LIMIT + 1),
    db.from("kb_articles").select("id, slug, visibility, belt_id").not("belt_id", "is", null),
  ]);
  for (const result of [beltsResult, topicsResult, entriesResult, pagesResult]) {
    if (result.error) throw new Error(result.error.message);
  }
  const entries = (entriesResult.data ?? []) as EntryListRow[];
  if (entries.length > ENTRIES_LIMIT) {
    throw new Error(
      `The syllabus has more than ${ENTRIES_LIMIT} blocks, which is more than can be read at once.`,
    );
  }
  return {
    belts: (beltsResult.data ?? []) as BeltRow[],
    topics: (topicsResult.data ?? []) as SyllabusTopicRow[],
    entries,
    pages: (pagesResult.data ?? []) as BeltPageRow[],
  };
}

type SyllabusRows = Awaited<ReturnType<typeof loadSyllabusRows>>;

/**
 * The rows as the pure syllabus module wants them, by slug rather than id.
 *
 * With a `viewer`, only the belts whose page that reader may open are kept, and
 * only their text: a belt page still being written at `managers` visibility
 * never reaches a member through the "up to belt X" view, which is the same
 * answer opening the page itself gives them. Without one (the manager screen,
 * the agent API) everything is kept, including a belt with no page yet.
 */
export function toSyllabusData(rows: SyllabusRows, viewer?: Viewer): SyllabusData {
  const pageByBelt = new Map(rows.pages.map((p) => [p.belt_id, p]));
  const belts: (SyllabusBelt & { id: string })[] = rows.belts
    .map((b) => {
      const page = pageByBelt.get(b.id) ?? null;
      return {
        id: b.id,
        slug: b.slug,
        name: b.name,
        grade: b.grade,
        colour: b.colour,
        position: b.position,
        page_slug: page?.slug ?? null,
        visibility: page ? (page.visibility as SyllabusBelt["visibility"]) : null,
      };
    })
    .filter((b) => !viewer || (b.visibility !== null && canReadArticle(b.visibility, viewer)));

  const beltSlugById = new Map(belts.map((b) => [b.id, b.slug]));
  const topicSlugById = new Map(rows.topics.map((t) => [t.id, t.slug]));
  const topics: SyllabusTopic[] = rows.topics.map((t) => ({
    slug: t.slug,
    title: t.title,
    parent: t.parent_id ? (topicSlugById.get(t.parent_id) ?? null) : null,
    position: t.position,
  }));
  const entries: SyllabusEntry[] = rows.entries.flatMap((e) => {
    const belt = beltSlugById.get(e.belt_id);
    const topic = topicSlugById.get(e.topic_id);
    return belt && topic ? [{ belt, topic, body_md: e.body_md }] : [];
  });

  return {
    belts: orderBelts(belts).map(({ id: _id, ...belt }) => belt),
    topics,
    entries,
  };
}

/** The syllabus for one reader, or (without a viewer) all of it. */
export async function loadSyllabus(db: KbClient, viewer?: Viewer): Promise<SyllabusData> {
  return toSyllabusData(await loadSyllabusRows(db), viewer);
}

// ---- Belt pages ----

/** What republishing did to one belt's page. */
export type BeltPageResult = {
  belt: string;
  page: string;
  /** The version published, or null when the page already said this. */
  version: number | null;
  /** True when this save made the page. */
  created: boolean;
};

/** The syllabus section's id, making the section if the club has none. */
async function ensureSyllabusSection(db: KbClient): Promise<string> {
  const { data: existing, error } = await db
    .from("kb_sections")
    .select("id")
    .eq("kind", "syllabus")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return existing.id;

  const { data: last, error: lastErr } = await db
    .from("kb_sections")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) throw new Error(lastErr.message);
  const { data: created, error: insErr } = await db
    .from("kb_sections")
    .insert({
      slug: SYLLABUS_SECTION_SLUG,
      title: "Syllabus",
      kind: "syllabus",
      position: (last?.position ?? 0) + 10,
    })
    .select("id")
    .single();
  if (insErr || !created) {
    throw new Error(
      insErr && /duplicate key/i.test(insErr.message)
        ? `There is already a section called "${SYLLABUS_SECTION_SLUG}" that is not the syllabus. Rename its URL key, then save again.`
        : (insErr?.message ?? "Could not create the syllabus section."),
    );
  }
  return created.id;
}

/**
 * Make a belt's page, at MANAGERS visibility.
 *
 * Managers-only because a belt whose first block has just been written is a
 * belt being written: publishing it to every member the moment it has one line
 * would put a half-finished syllabus in front of the people being graded on it.
 * A manager opens it to members when it is ready, the same way as any draft.
 */
async function createBeltPage(
  db: KbClient,
  belt: Pick<BeltRow, "id" | "slug" | "position">,
  actingAs: string | null,
): Promise<BeltPageRow> {
  const sectionId = await ensureSyllabusSection(db);
  const slug = beltPageSlug(belt.slug);
  const { data: taken, error: takenErr } = await db
    .from("kb_articles")
    .select("id, belt_id")
    .eq("slug", slug)
    .maybeSingle();
  if (takenErr) throw new Error(takenErr.message);
  if (taken) {
    throw new SyllabusError(
      `There is already an article at /kb/${slug} that is not this belt's page, so the page could not be made. Give that article another URL key, then save again.`,
      "conflict",
    );
  }
  const { data: created, error } = await db
    .from("kb_articles")
    .insert({
      slug,
      visibility: "managers",
      annotations_enabled: true,
      section_id: sectionId,
      position: belt.position,
      belt_id: belt.id,
      created_by: actingAs,
    })
    .select("id, slug, visibility, belt_id")
    .single();
  if (error || !created) throw new Error(error?.message ?? "Could not create the belt page.");
  return created as BeltPageRow;
}

/**
 * Mark everybody who had read `from` as having read `to`.
 *
 * Only for a new version holding exactly the blocks the old one did, in a new
 * order: the reader has read every word of it already, and telling them the
 * page was "updated since you read it" because a manager moved a topic would
 * spend the one signal that is meant to say the words changed. Best effort: if
 * it fails, readers see the page as updated, which is the safe direction.
 */
async function carryReadsForward(
  db: KbClient,
  articleId: string,
  from: number,
  to: number,
): Promise<void> {
  const { error } = await db
    .from("kb_article_reads")
    .update({ version: to })
    .eq("article_id", articleId)
    .eq("version", from);
  if (error) console.warn("[syllabus] could not carry reading progress forward:", error.message);
}

/**
 * Put each named belt's page back together from its blocks, and publish the
 * ones that now say something different.
 *
 * `create` makes a page for a belt that has text and no page yet. Only a save
 * of text does that: renaming a topic must not conjure pages for every belt.
 *
 * Every belt is attempted even when one fails, and the failures are reported
 * together afterwards, because the blocks are already saved by then: one page
 * failing must not leave the others stale too. Saving again retries cleanly,
 * since a page already up to date writes nothing.
 */
export async function republishBeltPages(
  db: KbClient,
  beltIds: string[] | "all",
  opts: { changeNote: string | null; actingAs: string | null; create?: boolean },
): Promise<BeltPageResult[]> {
  const rows = await loadSyllabusRows(db);
  const data = toSyllabusData(rows);
  const pageByBelt = new Map(rows.pages.map((p) => [p.belt_id, p]));
  const hasText = new Set(rows.entries.map((e) => e.belt_id));
  const scope = beltIds === "all" ? rows.belts : rows.belts.filter((b) => beltIds.includes(b.id));

  // Every live version in scope in one read, rather than one round trip per
  // belt before anything can be compared.
  const pageIds = scope.flatMap((b) => {
    const page = pageByBelt.get(b.id);
    return page ? [page.id] : [];
  });
  const liveByPage = new Map<string, { title: string; body_md: string; version: number }>();
  if (pageIds.length) {
    const { data: liveRows, error } = await db
      .from("kb_article_versions")
      .select("article_id, title, body_md, version")
      .in("article_id", pageIds)
      .eq("is_current", true);
    if (error) throw new Error(error.message);
    for (const row of liveRows ?? []) liveByPage.set(row.article_id, row);
  }

  // The section a new page goes in, made once up front if needed: two belts
  // each making it at the same moment below would race on its unique slug.
  if (opts.create && scope.some((b) => !pageByBelt.has(b.id) && hasText.has(b.id))) {
    await ensureSyllabusSection(db);
  }

  // Every belt at once. Each page is its own article with its own versions, so
  // nothing here is shared between them, and done one after another a topic
  // moved on seven belt pages took about eight seconds: six round trips per
  // page, back to back.
  const outcomes = await Promise.allSettled(
    orderBelts(scope).map(async (belt): Promise<BeltPageResult | null> => {
      let page = pageByBelt.get(belt.id) ?? null;
      let created = false;
      if (!page) {
        if (!opts.create || !hasText.has(belt.id)) return null;
        page = await createBeltPage(db, belt, opts.actingAs);
        created = true;
      }

      const title = beltPageTitle(belt);
      const body = composeBeltPage(belt.slug, data.topics, data.entries);
      const live = liveByPage.get(page.id);
      if (live && live.title === title && sameBlocks(live.body_md, body)) {
        return { belt: belt.slug, page: page.slug, version: null, created };
      }

      const version = await writeArticleVersion(
        db,
        page.id,
        { title, body_md: body, change_note: opts.changeNote },
        opts.actingAs,
      );
      if (live && live.title === title && sameBlockSet(live.body_md, body)) {
        await carryReadsForward(db, page.id, live.version, version);
      }
      return { belt: belt.slug, page: page.slug, version, created };
    }),
  );

  const results: BeltPageResult[] = [];
  const failures: string[] = [];
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      if (outcome.value) results.push(outcome.value);
    } else {
      const reason = outcome.reason;
      failures.push(
        `${beltPageTitle(orderBelts(scope)[i])}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  });

  if (failures.length) {
    throw new SyllabusError(
      `The syllabus is saved, but ${failures.length === 1 ? "one belt page" : `${failures.length} belt pages`} could not be updated to match it. Save again to retry. ${failures.join(" ")}`,
      "not_published",
    );
  }
  return results;
}

// ---- Belts ----

async function findBelt(db: KbClient, slug: string): Promise<BeltRow | null> {
  const { data, error } = await db.from("belts").select("*").eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as BeltRow | null) ?? null;
}

/**
 * Create a belt, or change one. An unknown slug creates it; an omitted field
 * is left alone.
 *
 * A new name or grade republishes the belt's page, because its title is built
 * from both. A new position moves the page in the syllabus section, which
 * writes no version: reordering belts tells no reader anything was updated.
 */
export async function saveBelt(
  db: KbClient,
  input: SaveBeltInput,
  actingAs: string | null,
): Promise<{ slug: string; created: boolean; pages: BeltPageResult[] }> {
  const existing = await findBelt(db, input.slug);
  if (existing && input.expect_new) {
    throw new SyllabusError(
      `There is already a belt "${input.slug}" (${existing.name}). Change it, rather than creating it again.`,
      "conflict",
    );
  }

  if (!existing) {
    if (!input.name || !input.colour) {
      throw new SyllabusError(
        `There is no belt "${input.slug}" yet, so creating it needs a name and a colour.`,
        "invalid",
      );
    }
    let position = input.position;
    if (position === undefined) {
      const { data: last, error } = await db
        .from("belts")
        .select("position")
        .order("position", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      position = (last?.position ?? 0) + 10;
    }
    const { error } = await db.from("belts").insert({
      slug: input.slug,
      name: input.name,
      grade: input.grade || null,
      colour: input.colour,
      position,
    });
    if (error) throw new Error(error.message);
    return { slug: input.slug, created: true, pages: [] };
  }

  const patch: Partial<BeltRow> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.grade !== undefined) patch.grade = input.grade || null;
  if (input.colour !== undefined) patch.colour = input.colour;
  if (input.position !== undefined) patch.position = input.position;
  if (Object.keys(patch).length === 0) return { slug: input.slug, created: false, pages: [] };

  const { error } = await db
    .from("belts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", existing.id);
  if (error) throw new Error(error.message);

  if (input.position !== undefined && input.position !== existing.position) {
    const { error: moveErr } = await db
      .from("kb_articles")
      .update({ position: input.position, updated_at: new Date().toISOString() })
      .eq("belt_id", existing.id);
    if (moveErr) throw new Error(moveErr.message);
  }

  const retitled =
    (input.name !== undefined && input.name !== existing.name) ||
    (input.grade !== undefined && (input.grade || null) !== existing.grade);
  const pages = retitled
    ? await republishBeltPages(db, [existing.id], {
        changeNote: `Belt renamed to ${beltPageTitle({ name: patch.name ?? existing.name, grade: patch.grade === undefined ? existing.grade : patch.grade })}`,
        actingAs,
      })
    : [];
  return { slug: input.slug, created: false, pages };
}

/**
 * Delete a belt made by mistake.
 *
 * Refused for a belt with a page or with any syllabus text, in words that say
 * what is in the way. A knowledge base article cannot be deleted, so a belt
 * with a page would leave that page describing a belt that no longer exists.
 */
export async function deleteBelt(db: KbClient, slug: string): Promise<{ slug: string }> {
  const belt = await findBelt(db, slug);
  if (!belt) throw new SyllabusError(`There is no belt "${slug}".`, "not_found");

  const [{ data: page, error: pageErr }, { count, error: countErr }] = await Promise.all([
    db.from("kb_articles").select("slug").eq("belt_id", belt.id).maybeSingle(),
    db
      .from("syllabus_entries")
      .select("topic_id", { count: "exact", head: true })
      .eq("belt_id", belt.id),
  ]);
  if (pageErr) throw new Error(pageErr.message);
  if (countErr) throw new Error(countErr.message);
  if (page) {
    throw new SyllabusError(
      `${belt.name} has a syllabus page at /kb/${page.slug}, so it cannot be deleted. Pages are kept for good; rename the belt instead.`,
      "conflict",
    );
  }
  if (count) {
    throw new SyllabusError(
      `${belt.name} has syllabus text on ${count} topic${count === 1 ? "" : "s"}. Clear it first.`,
      "conflict",
    );
  }

  const { error } = await db.from("belts").delete().eq("id", belt.id);
  if (error) throw new Error(error.message);
  return { slug };
}

// ---- Topics ----

async function findTopic(db: KbClient, slug: string): Promise<SyllabusTopicRow | null> {
  const { data, error } = await db
    .from("syllabus_topics")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SyllabusTopicRow | null) ?? null;
}

/**
 * Create a topic, rename it, move it, or file it under another.
 *
 * Its slug is never changed: it is the heading's anchor on every belt page and
 * the `topic=` in every shared link, so renaming changes the title only, and
 * the belt pages pin the old anchor to the new words (`topicHeading`).
 *
 * Two levels only, checked here because a CHECK cannot see the parent: a topic
 * can sit under a top-level topic, and a topic with sub-topics of its own
 * cannot be moved under anything.
 *
 * A change that alters how belt pages read (a new title, a new place) ends by
 * republishing them; the pages a topic does not appear on are left alone, since
 * they come out block for block the same.
 */
export async function saveSyllabusTopic(
  db: KbClient,
  input: SaveSyllabusTopicInput,
  actingAs: string | null,
): Promise<{ slug: string; created: boolean; pages: BeltPageResult[] }> {
  const existing = await findTopic(db, input.slug);
  if (existing && input.expect_new) {
    throw new SyllabusError(
      `There is already a topic "${input.slug}" (${existing.title}). Change it, rather than creating it again.`,
      "conflict",
    );
  }

  let parentId: string | null | undefined;
  if (input.parent === "") parentId = null;
  else if (input.parent !== undefined) {
    const parent = await findTopic(db, input.parent);
    if (!parent) {
      throw new SyllabusError(
        `There is no topic "${input.parent}" to put this under. List the topics first.`,
        "invalid",
      );
    }
    if (parent.parent_id !== null) {
      throw new SyllabusError(
        `"${parent.title}" is itself a sub-topic, and the syllabus goes only one level deep. Put this under a main topic instead.`,
        "invalid",
      );
    }
    parentId = parent.id;
  }

  if (parentId && existing) {
    const { count, error } = await db
      .from("syllabus_topics")
      .select("id", { count: "exact", head: true })
      .eq("parent_id", existing.id);
    if (error) throw new Error(error.message);
    if (count) {
      throw new SyllabusError(
        `"${existing.title}" has sub-topics of its own, so it cannot go under another topic: the syllabus goes only one level deep.`,
        "invalid",
      );
    }
  }

  if (!existing) {
    if (!input.title) {
      throw new SyllabusError(
        `There is no topic "${input.slug}" yet, so creating it needs a title.`,
        "invalid",
      );
    }
    const position = input.position ?? (await nextTopicPosition(db, parentId ?? null));
    const { error } = await db.from("syllabus_topics").insert({
      slug: input.slug,
      title: input.title,
      parent_id: parentId ?? null,
      position,
    });
    if (error) throw new Error(error.message);
    // A new topic has no text on any belt yet, so no page changes.
    return { slug: input.slug, created: true, pages: [] };
  }

  const patch: Partial<SyllabusTopicRow> = {};
  if (input.title !== undefined && input.title !== existing.title) patch.title = input.title;
  if (parentId !== undefined && parentId !== existing.parent_id) {
    patch.parent_id = parentId;
    // Filed under another topic with no position given, it goes LAST among its
    // new siblings. Keeping its old number would drop it wherever that number
    // happens to fall in a list it was never ordered against.
    if (input.position === undefined) patch.position = await nextTopicPosition(db, parentId);
  }
  if (input.position !== undefined && input.position !== existing.position) {
    patch.position = input.position;
  }
  if (Object.keys(patch).length === 0) return { slug: input.slug, created: false, pages: [] };

  const { error } = await db
    .from("syllabus_topics")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", existing.id);
  if (error) throw new Error(error.message);

  const pages = await republishBeltPages(db, "all", {
    changeNote: input.change_note || defaultTopicNote(existing, patch),
    actingAs,
  });
  return { slug: input.slug, created: false, pages };
}

/** The position after the last topic under `parentId` (null: the top level). */
async function nextTopicPosition(db: KbClient, parentId: string | null): Promise<number> {
  let query = db.from("syllabus_topics").select("position");
  query = parentId ? query.eq("parent_id", parentId) : query.is("parent_id", null);
  const { data: last, error } = await query
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (last?.position ?? 0) + 10;
}

/**
 * Put several topics in a new order at once, then republish the belt pages
 * ONCE.
 *
 * The screen's arrows used to save each press as its own topic save, and each
 * one republished every belt page: three presses to move Drills up three places
 * was three rounds of new versions on every page, and three waits. The screen
 * now collects a burst of moves and sends the resulting positions here.
 *
 * Positions only: a topic's title and parent are changed with
 * `saveSyllabusTopic`. Unknown slugs refuse the whole call before anything is
 * written, naming each.
 */
export async function reorderSyllabusTopics(
  db: KbClient,
  input: ReorderSyllabusTopicsInput,
  actingAs: string | null,
): Promise<{ moved: number; pages: BeltPageResult[] }> {
  const slugs = input.topics.map((t) => t.slug);
  const { data: rows, error } = await db
    .from("syllabus_topics")
    .select("id, slug, position")
    .in("slug", slugs);
  if (error) throw new Error(error.message);
  const bySlug = new Map((rows ?? []).map((r) => [r.slug, r]));
  const unknown = slugs.filter((slug) => !bySlug.has(slug));
  if (unknown.length) {
    throw new SyllabusError(
      `Nothing was moved: there is no topic ${unknown.map((s) => `"${s}"`).join(", ")}.`,
      "invalid",
    );
  }

  const changes = input.topics.filter((t) => bySlug.get(t.slug)!.position !== t.position);
  if (!changes.length) return { moved: 0, pages: [] };
  const now = new Date().toISOString();
  const writes = await Promise.all(
    changes.map((t) =>
      db
        .from("syllabus_topics")
        .update({ position: t.position, updated_at: now })
        .eq("id", bySlug.get(t.slug)!.id),
    ),
  );
  const failed = writes.find((w) => w.error);
  if (failed?.error) throw new Error(failed.error.message);

  const pages = await republishBeltPages(db, "all", {
    changeNote: input.change_note || "Topics reordered",
    actingAs,
  });
  return { moved: changes.length, pages };
}

function defaultTopicNote(existing: SyllabusTopicRow, patch: Partial<SyllabusTopicRow>): string {
  if (patch.title !== undefined) return `"${existing.title}" renamed to "${patch.title}"`;
  return `"${existing.title}" moved`;
}

/**
 * Delete a topic made by mistake. Refused while it has sub-topics or any belt
 * has text on it, naming the belts, so deleting a topic can never take part of
 * the syllabus with it.
 */
export async function deleteSyllabusTopic(db: KbClient, slug: string): Promise<{ slug: string }> {
  const topic = await findTopic(db, slug);
  if (!topic) throw new SyllabusError(`There is no topic "${slug}".`, "not_found");

  const [{ count: children, error: childErr }, { data: used, error: usedErr }] = await Promise.all([
    db
      .from("syllabus_topics")
      .select("id", { count: "exact", head: true })
      .eq("parent_id", topic.id),
    db.from("syllabus_entries").select("belt_id").eq("topic_id", topic.id),
  ]);
  if (childErr) throw new Error(childErr.message);
  if (usedErr) throw new Error(usedErr.message);
  if (children) {
    throw new SyllabusError(
      `"${topic.title}" has sub-topics. Move or delete them first.`,
      "conflict",
    );
  }
  if (used?.length) {
    const ids = used.map((u) => u.belt_id);
    const { data: belts, error } = await db.from("belts").select("name").in("id", ids);
    if (error) throw new Error(error.message);
    const names = (belts ?? []).map((b) => b.name).join(", ");
    throw new SyllabusError(
      `"${topic.title}" still has text for ${names}. Clear it there first.`,
      "conflict",
    );
  }

  const { error } = await db.from("syllabus_topics").delete().eq("id", topic.id);
  if (error) throw new Error(error.message);
  return { slug };
}

// ---- Blocks ----

/**
 * Save blocks of syllabus text, then republish every belt page they changed,
 * once each.
 *
 * An empty `body_md` clears a block. Unknown belts or topics are refused as a
 * whole, before anything is written, naming every one: a typo in one slug of a
 * thirty-block save must not leave twenty-nine saved and one missing.
 *
 * Last save wins: two managers editing the same block at once each overwrite
 * the other, the way two saves of one article do. Every republish is a kept
 * version of the belt page, so nothing written is lost for good.
 */
export async function saveSyllabusEntries(
  db: KbClient,
  input: SaveSyllabusEntriesInput,
  actingAs: string | null,
): Promise<{ saved: number; cleared: number; pages: BeltPageResult[] }> {
  const beltSlugs = [...new Set(input.entries.map((e) => e.belt))];
  const topicSlugs = [...new Set(input.entries.map((e) => e.topic))];
  const [{ data: belts, error: beltErr }, { data: topics, error: topicErr }] = await Promise.all([
    db.from("belts").select("id, slug").in("slug", beltSlugs),
    db.from("syllabus_topics").select("id, slug").in("slug", topicSlugs),
  ]);
  if (beltErr) throw new Error(beltErr.message);
  if (topicErr) throw new Error(topicErr.message);

  const beltId = new Map((belts ?? []).map((b) => [b.slug, b.id]));
  const topicId = new Map((topics ?? []).map((t) => [t.slug, t.id]));
  const unknown = [
    ...beltSlugs.filter((s) => !beltId.has(s)).map((s) => `belt "${s}"`),
    ...topicSlugs.filter((s) => !topicId.has(s)).map((s) => `topic "${s}"`),
  ];
  if (unknown.length) {
    throw new SyllabusError(
      `Nothing was saved: there is no ${unknown.join(", no ")}. List the belts and topics first.`,
      "invalid",
    );
  }

  const now = new Date().toISOString();
  const upserts = input.entries
    .filter((e) => e.body_md.trim() !== "")
    .map((e) => ({
      belt_id: beltId.get(e.belt)!,
      topic_id: topicId.get(e.topic)!,
      body_md: tidyBlock(e.body_md),
      updated_by: actingAs,
      updated_at: now,
    }));
  const clears = input.entries.filter((e) => e.body_md.trim() === "");

  if (upserts.length) {
    const { error } = await db
      .from("syllabus_entries")
      .upsert(upserts, { onConflict: "belt_id,topic_id" });
    if (error) throw new Error(error.message);
  }
  for (const clear of clears) {
    const { error } = await db
      .from("syllabus_entries")
      .delete()
      .eq("belt_id", beltId.get(clear.belt)!)
      .eq("topic_id", topicId.get(clear.topic)!);
    if (error) throw new Error(error.message);
  }

  const pages = await republishBeltPages(db, [...new Set(beltSlugs.map((s) => beltId.get(s)!))], {
    changeNote: input.change_note || null,
    actingAs,
    create: true,
  });
  return { saved: upserts.length, cleared: clears.length, pages };
}

/**
 * Whether an article is a belt page, for the guards in `kb-admin.ts` and the
 * rollback path: a belt page's text comes from the syllabus, so restoring an
 * older version of it would put the page out of step with its own blocks.
 */
export async function beltOfVersion(db: KbClient, versionId: string): Promise<string | null> {
  const { data, error } = await db
    .from("kb_article_versions")
    .select("article_id")
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const { data: article, error: aErr } = await db
    .from("kb_articles")
    .select("belt_id")
    .eq("id", data.article_id)
    .maybeSingle();
  if (aErr) throw new Error(aErr.message);
  return article?.belt_id ?? null;
}
