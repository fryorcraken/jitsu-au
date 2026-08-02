// Reading and writing knowledge base articles and sections, with the client
// passed in.
//
// Split out of the server functions and the manager agent endpoint so both drive
// the same code — the agent API is the primary way managers edit the knowledge
// base, and a second implementation behind the web UI is how the two quietly stop
// agreeing about what "save" means. Taking the client as a parameter also makes
// the failure paths unit-testable, exactly as `promoteWaiverTemplate` and
// `applyCoverage` do: a `createServerFn` handler cannot run in the test runner.
import { visibilityReach } from "@/lib/kb";
import type {
  KbAnnotationRow,
  KbArticleRow,
  KbArticleVersionRow,
  KbClient,
  KbSectionRow,
} from "@/lib/kb-types";
import type { SaveKbArticleInput, SaveKbSectionInput } from "@/lib/validation";

/** An article together with the version being read. */
export type LoadedArticle = {
  article: KbArticleRow;
  version: KbArticleVersionRow;
};

/**
 * Make one version the live one, and report honestly when it cannot.
 *
 * The partial unique index allows exactly one `is_current = true` per article,
 * so this is necessarily two writes with a gap: clear, then set. Nothing can
 * close that gap from here — PostgREST gives each statement its own transaction
 * — so the job is to keep it short and be loud when an article is left in it.
 *
 * Directly modelled on `promoteWaiverTemplate`, including the recovery, with one
 * difference that matters: every write is scoped to ONE article_id. A clear
 * that forgot that scope would unpublish every other article in the club.
 */
export async function promoteArticleVersion(
  db: KbClient,
  versionId: string,
): Promise<{ version: number }> {
  const { data: target, error: tErr } = await db
    .from("kb_article_versions")
    .select("id, version, is_current, article_id")
    .eq("id", versionId)
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  // Both checks happen BEFORE anything is cleared: a bad id or an
  // already-current target must never cost the article its live version.
  if (!target) throw new Error("That article version no longer exists.");
  if (target.is_current) return { version: target.version };

  const { data: previous, error: pErr } = await db
    .from("kb_article_versions")
    .select("id")
    .eq("article_id", target.article_id)
    .eq("is_current", true)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);

  const { error: clearErr } = await db
    .from("kb_article_versions")
    .update({ is_current: false })
    .eq("article_id", target.article_id)
    .eq("is_current", true);
  if (clearErr) throw new Error(clearErr.message);

  const { error: setErr } = await db
    .from("kb_article_versions")
    .update({ is_current: true })
    .eq("id", target.id);
  if (!setErr) return { version: target.version };

  // From here the article has no live version until something sets one. The
  // likeliest cause is a concurrent save: somebody else cleared and set while we
  // were between our two writes, so ours hit the unique index. That is a race
  // with a winner, not a broken database.
  const { data: nowCurrent } = await db
    .from("kb_article_versions")
    .select("id")
    .eq("article_id", target.article_id)
    .eq("is_current", true)
    .maybeSingle();
  if (nowCurrent) {
    throw new Error(
      "Someone else published a version of this article a moment ago, so this change was not applied. Read it again before retrying.",
    );
  }

  if (previous) {
    const { error: restoreErr } = await db
      .from("kb_article_versions")
      .update({ is_current: true })
      .eq("id", previous.id);
    if (restoreErr) {
      // Both writes failed and nothing is live: the article now 404s for every
      // reader. Log it, and say so in words rather than surfacing a constraint.
      console.error("[promoteArticleVersion] could not restore the live version:", restoreErr);
      throw new Error(
        "The version could not be changed, and this article is now left with no published version, so nobody can read it. Try again now to fix it.",
      );
    }
  }
  throw new Error(setErr.message);
}

/** Every section, in sidebar order. */
export async function listKbSections(db: KbClient): Promise<KbSectionRow[]> {
  const { data, error } = await db.from("kb_sections").select("*").order("position").order("slug");
  if (error) throw new Error(error.message);
  return (data ?? []) as KbSectionRow[];
}

/**
 * Create or update a section. An unknown slug creates it, the same rule articles
 * follow, so an agent asked to add "Belts and grading" does not need a separate
 * create call first.
 */
export async function saveKbSection(
  db: KbClient,
  input: SaveKbSectionInput,
): Promise<{ slug: string; created: boolean }> {
  const { data: existing, error: findErr } = await db
    .from("kb_sections")
    .select("*")
    .eq("slug", input.slug)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  if (!existing) {
    // A new section needs a name; there is no version to borrow one from.
    if (!input.title) {
      throw new Error(`There is no section "${input.slug}" yet, so creating it needs a title.`);
    }
    const { error } = await db
      .from("kb_sections")
      .insert({ slug: input.slug, title: input.title, position: input.position ?? 0 });
    if (error) throw new Error(error.message);
    return { slug: input.slug, created: true };
  }

  // Omitted means unchanged, so renaming a section cannot silently move it.
  const patch: Partial<KbSectionRow> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.position !== undefined) patch.position = input.position;
  const { error } = await db.from("kb_sections").update(patch).eq("slug", input.slug);
  if (error) throw new Error(error.message);
  return { slug: input.slug, created: false };
}

/**
 * Delete a section.
 *
 * Its articles are NOT deleted with it — `section_id` is `ON DELETE SET NULL`,
 * so they fall into the "Everything else" group, which is visible and
 * recoverable. That is the whole reason deleting one is safe enough to offer on
 * a screen: the worst case is a manager re-filing a few articles, not a club
 * losing its handbook because it tidied its navigation.
 *
 * Reports how many articles were displaced so the caller can say so, rather
 * than a silent "deleted" that leaves the manager to discover the sidebar has
 * changed shape.
 */
export async function deleteKbSection(
  db: KbClient,
  slug: string,
): Promise<{ slug: string; displaced: number }> {
  const { data: section, error: findErr } = await db
    .from("kb_sections")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (!section) throw new Error(`There is no section "${slug}".`);

  // Counted BEFORE the delete: afterwards the rows no longer name it.
  const { count, error: cntErr } = await db
    .from("kb_articles")
    .select("id", { count: "exact", head: true })
    .eq("section_id", section.id);
  if (cntErr) throw new Error(cntErr.message);

  const { error } = await db.from("kb_sections").delete().eq("id", section.id);
  if (error) throw new Error(error.message);
  return { slug, displaced: count ?? 0 };
}

/**
 * Resolve a section slug to its id for a save.
 *
 * An empty string is "take it out of every section" (it lands in the
 * "Everything else" group), `undefined` is "leave it where it is", and an
 * unknown slug is refused rather than silently dropping the article out of the
 * sidebar — a typo there is otherwise invisible until someone notices an article
 * has gone missing from its group.
 */
async function resolveSectionId(
  db: KbClient,
  section: string | undefined,
): Promise<string | null | undefined> {
  if (section === undefined) return undefined;
  if (section === "") return null;
  const { data, error } = await db
    .from("kb_sections")
    .select("id")
    .eq("slug", section)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error(
      `There is no section "${section}". Create it with save_kb_section, or list the sections first.`,
    );
  }
  return data.id;
}

/**
 * Create or update an article, always as a NEW version.
 *
 * An unknown slug creates the article; a known one adds a version to it. That
 * is what makes the manager agent API usable without a separate "create" call:
 * an agent asked to publish the house rules does not have to know whether the
 * club already has a page for them.
 *
 * Everything except the slug is optional and an omitted field is LEFT ALONE, so
 * an agent editing the text of a managers-only draft cannot publish it to the
 * world, or move it to the top of the sidebar, by not mentioning a field. A save
 * that names neither `title` nor `body_md` writes no version at all: that is how
 * "move this article into Start here" is one call rather than a republish.
 */
export async function saveKbArticle(
  db: KbClient,
  input: SaveKbArticleInput,
  actingAs: string | null,
): Promise<{ slug: string; version: number | null; article_id: string; created: boolean }> {
  const createdBy = actingAs && isUuid(actingAs) ? actingAs : null;
  const sectionId = await resolveSectionId(db, input.section);

  const { data: existing, error: findErr } = await db
    .from("kb_articles")
    .select("*")
    .eq("slug", input.slug)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  let article = existing as KbArticleRow | null;
  const created = !article;
  // Held as a narrowed pair rather than a boolean so the insert below can see
  // that both halves are present. The column is NOT NULL and the schema makes
  // both optional (a placement-only save sends neither), so a bare boolean
  // leaves `string | undefined` reaching a `string` column.
  const text = input.title && input.body_md ? { title: input.title, body_md: input.body_md } : null;
  const writingText = text !== null;

  // The caller believed it was creating this article. It is not, and carrying on
  // would add a version to somebody else's page and patch its visibility to
  // whatever this caller happened to have selected. The web editor checks its
  // own list first, but that list is a snapshot and this is not: between it
  // loading and this save, another manager or the agent API can create the slug.
  if (article && input.expect_new) {
    throw new Error(
      `An article already exists at /kb/${input.slug}. Open it and save a new version, rather than creating it again.`,
    );
  }

  // A link entry is a sidebar item pointing at a page elsewhere on the site, so
  // it has nowhere to render text. The schema already refuses text alongside a
  // `link_path` in the same call; these two guards catch the other direction,
  // where the two halves arrive in separate saves. A CHECK cannot see across
  // tables, so this is where the rule lives — the same reason one-level-deep
  // replies are enforced in `createAnnotation` rather than in the schema.
  // Text on a link entry is only allowed when the same call is turning it back
  // into an article, which is what `link_path: ""` says. The schema already
  // requires the text to travel with that, so this is the case where a caller
  // sent text and left the link in place.
  if (article?.link_path && writingText && input.link_path !== "") {
    throw new Error(
      `"${input.slug}" is a link to ${article.link_path}, not an article. Send link_path: "" together with title and body_md to turn it into one, or use a different slug.`,
    );
  }

  // A link entry has no version to borrow a name from, so clearing its label
  // would leave a blank row in the sidebar. The DB constraint catches this, but
  // as a raw `violates check constraint` string that tells a manager nothing.
  if (article?.link_path && input.nav_title === "" && input.link_path !== "") {
    throw new Error(
      `"${input.slug}" is a link, and a link needs a name to show in the sidebar, so nav_title cannot be cleared.`,
    );
  }
  if (input.link_path && article && !article.link_path) {
    const { count, error: cntErr } = await db
      .from("kb_article_versions")
      .select("id", { count: "exact", head: true })
      .eq("article_id", article.id);
    if (cntErr) throw new Error(cntErr.message);
    if (count) {
      throw new Error(
        `"${input.slug}" is an article with ${count} saved version(s), so it cannot become a link. Use a different slug for the link.`,
      );
    }
  }

  if (!article) {
    if (!writingText && !input.link_path) {
      throw new Error(
        `There is no article "${input.slug}" yet. Creating one needs a title and body_md, or a link_path and nav_title.`,
      );
    }
    const { data: inserted, error: insErr } = await db
      .from("kb_articles")
      .insert({
        slug: input.slug,
        // The schema default is `members`, and it is repeated here rather than
        // left implicit: an article created through the API with no visibility
        // named should be members-only for a reason a reader of THIS code can
        // see, not because of a column default three files away.
        visibility: input.visibility ?? "members",
        // A link entry takes no comments: there is no text held here to anchor
        // them to.
        annotations_enabled: input.link_path ? false : (input.annotations_enabled ?? true),
        section_id: sectionId ?? null,
        position: input.position ?? 0,
        nav_title: input.nav_title || null,
        link_path: input.link_path || null,
        created_by: createdBy,
      })
      .select("*")
      .single();
    if (insErr || !inserted) throw new Error(insErr?.message ?? "Could not create the article.");
    article = inserted as KbArticleRow;
  }

  /**
   * Write the article's own settings: visibility, whether it takes comments, and
   * where it sits in the sidebar.
   *
   * `textIsLive` shapes the failure message only. It is the difference between
   * "nothing happened" and "your words are published under the old audience",
   * and a manager told the first when the second is true will retype the save
   * rather than go and check.
   */
  const patch: Partial<KbArticleRow> = {};
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.annotations_enabled !== undefined) {
    patch.annotations_enabled = input.annotations_enabled;
  }
  if (sectionId !== undefined) patch.section_id = sectionId;
  if (input.position !== undefined) patch.position = input.position;
  if (input.nav_title !== undefined) patch.nav_title = input.nav_title || null;
  // `""` is a clear, and the column's CHECK accepts only a real path or NULL.
  if (input.link_path !== undefined) patch.link_path = input.link_path || null;

  const patchSettings = async (textIsLive: boolean) => {
    const { data: updated, error: updErr } = await db
      .from("kb_articles")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", article!.id)
      .select("*")
      .single();
    if (updErr || !updated) {
      throw new Error(
        textIsLive
          ? `The new text is published, but who can read "${input.slug}" could not be changed, so it is still ${article!.visibility}. Try that change again.`
          : (updErr?.message ?? "Could not update the article."),
      );
    }
    article = updated as KbArticleRow;
  };

  // Which side of the version write the settings go on.
  //
  // `visibility` lives on the article and the text lives on the version, so the
  // two writes cannot be made atomic from PostgREST. The only question is which
  // way a half-failed save should fail, and that depends on the direction:
  //
  // - WIDENING (managers -> members): patch LAST. A failure leaves the new text
  //   live under the OLD, narrower audience.
  // - NARROWING (public -> managers): patch FIRST. A failure leaves the OLD text
  //   under the new, narrower audience. Patching last would publish the new text
  //   — usually the whole reason for narrowing — to the wider audience it was
  //   being taken away from, while telling the caller the save failed.
  //
  // Either way the failure direction is "fewer people can read it", which is the
  // only one that cannot be undone by trying again.
  const hasSettings = !created && Object.keys(patch).length > 0;
  const narrowing =
    input.visibility !== undefined &&
    visibilityReach[input.visibility] < visibilityReach[article.visibility];

  if (hasSettings && narrowing) await patchSettings(false);

  let versionNumber: number | null = null;

  if (text) {
    // A failed read here would number the new version 1 and collide with the
    // existing version 1, so the save would fail on a duplicate-key message that
    // says nothing about what went wrong. (Same guard as `saveWaiverTemplate`.)
    const { data: maxRow, error: maxErr } = await db
      .from("kb_article_versions")
      .select("version")
      .eq("article_id", article.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw new Error(maxErr.message);
    const nextVersion = (maxRow?.version ?? 0) + 1;

    // Write the new version as a draft, THEN promote it. The obvious order (clear
    // `is_current`, then insert the row already current) leaves the article
    // unreadable if the insert fails, with nothing to roll back to. This way a
    // failed insert changes nothing, and a failed promotion leaves the previous
    // version live with an unused draft behind it.
    const { data: createdVersion, error: verErr } = await db
      .from("kb_article_versions")
      .insert({
        article_id: article.id,
        version: nextVersion,
        title: text.title,
        body_md: text.body_md,
        change_note: input.change_note || null,
        is_current: false,
        created_by: createdBy,
      })
      .select("id, version")
      .single();
    if (verErr || !createdVersion) {
      // A unique violation here is the version-number race, not a broken
      // database: two saves read the same MAX(version) and both tried to write
      // n+1. `MAX(version)+1` cannot be made atomic from PostgREST, so the job is
      // to lose the race in words the caller can act on rather than surfacing
      // `duplicate key value violates unique constraint ...`, which reads like a
      // bug and tells an agent nothing about what to do next.
      if (verErr && (verErr.code === "23505" || /duplicate key/i.test(verErr.message))) {
        throw new Error(
          "Someone else saved a version of this article a moment ago, so this save was not applied. Read it again before retrying.",
        );
      }
      throw new Error(verErr?.message ?? "Could not save the article version.");
    }

    await promoteArticleVersion(db, createdVersion.id);
    versionNumber = createdVersion.version;
  }

  if (hasSettings && !narrowing) await patchSettings(writingText);

  return {
    slug: article.slug,
    version: versionNumber,
    article_id: article.id,
    created,
  };
}

/**
 * Load an article by slug, with one version: the live one, or a named one.
 *
 * Returns null when the article does not exist. An article that exists but has
 * no published version also returns null — from a reader's point of view there
 * is nothing to show, and every caller would otherwise have to invent the same
 * answer for a state only a half-failed save can produce. A LINK ENTRY has no
 * versions by definition, so it lands here too; callers that need to tell those
 * apart read the row through `loadKbArticleRow`.
 */
export async function loadKbArticle(
  db: KbClient,
  slug: string,
  version?: number,
): Promise<LoadedArticle | null> {
  const article = await loadKbArticleRow(db, slug);
  if (!article) return null;

  let query = db.from("kb_article_versions").select("*").eq("article_id", article.id);
  query = version === undefined ? query.eq("is_current", true) : query.eq("version", version);
  const { data: versionRow, error: verErr } = await query.maybeSingle();
  if (verErr) throw new Error(verErr.message);
  if (!versionRow) return null;

  return { article, version: versionRow as KbArticleVersionRow };
}

/** The article row alone, with no version attached. */
export async function loadKbArticleRow(db: KbClient, slug: string): Promise<KbArticleRow | null> {
  const { data, error } = await db.from("kb_articles").select("*").eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as KbArticleRow | null) ?? null;
}

/** The article shape the API and the reader both return. */
export function projectArticle({ article, version }: LoadedArticle) {
  return {
    slug: article.slug,
    title: version.title,
    body_md: version.body_md,
    version: version.version,
    is_current_version: version.is_current,
    change_note: version.change_note,
    visibility: article.visibility,
    annotations_enabled: article.annotations_enabled,
    nav_title: article.nav_title,
    updated_at: version.created_at,
  };
}

/**
 * The SHARED annotations on an article, for a manager reading feedback back.
 *
 * Takes its client as a parameter so the privacy filter is unit-testable, which
 * matters more here than anywhere else in the feature: the `.eq("visibility",
 * "shared")` below is the single line stopping a manager from reading members'
 * private notes, and inside a `createServerFn` handler no test can reach it.
 *
 * Shared only, and that is not an oversight to be fixed later. A private note is
 * private from the club too (see the migration), which is what makes it usable
 * for "things I want to remember about this policy". A manager gets the
 * conversation, never somebody's notebook.
 */
export async function listSharedAnnotations(
  db: KbClient,
  articleId: string,
  opts: { includeResolved?: boolean; version?: number; limit: number },
): Promise<KbAnnotationRow[]> {
  let query = db
    .from("kb_annotations")
    .select("*")
    .eq("article_id", articleId)
    .eq("visibility", "shared")
    .order("created_at", { ascending: true });
  if (opts.version !== undefined) query = query.eq("article_version", opts.version);
  if (!opts.includeResolved) query = query.is("resolved_at", null);

  const { data, error } = await query.limit(opts.limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as KbAnnotationRow[];
}

/** An annotation as the manager API reports it. */
export function projectAnnotation(row: KbAnnotationRow, authorName: string | null) {
  return {
    id: row.id,
    author: authorName,
    author_user_id: row.user_id,
    visibility: row.visibility,
    article_version: row.article_version,
    block_id: row.block_id,
    quote: row.quote,
    parent_id: row.parent_id,
    body: row.body,
    resolved: Boolean(row.resolved_at),
    resolved_at: row.resolved_at,
    created_at: row.created_at,
  };
}

/**
 * Whether a string is a UUID, used to decide if an actor can be recorded as
 * `created_by`. The manager agent's break-glass env key authenticates as
 * `AGENT_ENV_KEY_UPLOADER`, which is deliberately not a UUID and has no auth
 * user behind it — writing it into a `references auth.users` column would fail
 * the insert outright. `filePaperWaiver` makes the same check for the same reason.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
