// Row/client types for the knowledge base.
//
// These alias the GENERATED `integrations/supabase/types.ts`, which is derived
// from the live database, so a column that is renamed or dropped there fails the
// typecheck here rather than drifting quietly (see "Schema drift" in CLAUDE.md).
// They were hand-written while `20260802100000_knowledge_base.sql` was committed
// but unapplied; that migration is applied and the types brought back in step,
// so the hand-written shapes are gone.
//
// The one narrowing: `visibility` is a text column with a CHECK, not an enum, so
// the generator can only say `string`. The app's own unions are the real values,
// and every read is filtered or compared against them, so they are asserted here
// in ONE place instead of being cast at each call site.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnnotationVisibility, ArticleVisibility } from "@/lib/kb";

type Tables = Database["public"]["Tables"];

/** A group of articles in the sidebar. Ordering only: sections hold no text. */
export type KbSectionRow = Tables["kb_sections"]["Row"];

/**
 * An article's identity: its URL key, who may read it, and where it sits.
 *
 * `link_path` makes the row a LINK ENTRY rather than an article: a sidebar item
 * pointing at a page elsewhere on the site (`/first-class`, `/faq`) with no
 * versions of its own. `nav_title` is then the only name it has, which is why
 * the schema requires one.
 */
export type KbArticleRow = Omit<Tables["kb_articles"]["Row"], "visibility"> & {
  visibility: ArticleVisibility;
};

/** One saved version of an article's text. */
export type KbArticleVersionRow = Tables["kb_article_versions"]["Row"];

/** That a person read an article, and which version of it they read. */
export type KbArticleReadRow = Tables["kb_article_reads"]["Row"];

/** A private note or a shared comment, anchored to a block of a version. */
export type KbAnnotationRow = Omit<Tables["kb_annotations"]["Row"], "visibility"> & {
  visibility: AnnotationVisibility;
};

/**
 * The client the knowledge base code takes.
 *
 * A plain generated client — the knowledge base tables are in `types.ts` now, so
 * nothing has to be widened. Named rather than inlined so the handlers and the
 * test harnesses keep referring to one thing.
 */
export type KbClient = SupabaseClient<Database>;
