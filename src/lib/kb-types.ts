// Row/client types for the knowledge base.
//
// These alias the GENERATED `integrations/supabase/types.ts` wherever they can,
// which is derived from the live database, so a column that is renamed or
// dropped there fails the typecheck here rather than drifting quietly (see
// "Schema drift" in CLAUDE.md).
//
// > [!IMPORTANT]
// > **The live database still has the OLD table names.**
// > `20260802100000_knowledge_base.sql` renames `documents` -> `kb_articles`
// > (and adds `kb_sections` plus four columns), but committing a migration does
// > not apply it, so the generator has emitted nothing under the new names yet.
// >
// > So this file does two things, and only the second is temporary:
// >
// >   1. Aliases the generated rows under their new names. Every column that
// >      exists live is still checked against the generator, which is the whole
// >      point of not hand-writing rows.
// >   2. Intersects in the columns the migration ADDS, hand-written, because
// >      there is nothing to read them from until it is applied.
// >
// > **When that migration has been applied and `types.ts` regenerated**, delete
// > the `Adds*` intersections and the `KbDatabase` remapping below, and alias
// > the real tables directly:
// >
// > ```ts
// > export type KbArticleRow = Tables["kb_articles"]["Row"];
// > ```
// >
// > **`src/integrations/supabase/schema-contract.test.ts` moves in the same
// > change.** It pins `Tables["documents"]`, `Tables["document_versions"]` and
// > `Tables["document_annotations"]`; regeneration removes those three keys, so
// > the contract test stops compiling and `main` goes red — the exact failure
// > CLAUDE.md records from 2026-07-29. Repoint it at the new names and add pins
// > for `kb_sections` and the four new columns, which have none today.
//
// The one narrowing that survives either way: `visibility` is a text column with
// a CHECK, not an enum, so the generator can only say `string`. The app's own
// unions are the real values, and every read is filtered or compared against
// them, so they are asserted here in ONE place instead of at each call site.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnnotationVisibility, ArticleVisibility } from "@/lib/kb";

type Tables = Database["public"]["Tables"];

/**
 * A group of articles in the sidebar. Ordering only: sections hold no text.
 *
 * Wholly hand-written, because the table does not exist live yet.
 */
export type KbSectionRow = {
  id: string;
  slug: string;
  title: string;
  position: number;
  created_at: string;
  updated_at: string;
};

/** The columns `20260802100000_knowledge_base.sql` adds to an article. */
type AddsToArticle = {
  section_id: string | null;
  position: number;
  nav_title: string | null;
  /**
   * Set makes the row a LINK ENTRY rather than an article: a sidebar item
   * pointing at a page elsewhere on the site (`/first-class`, `/faq`) with no
   * versions of its own. `nav_title` is then the only name it has, which is why
   * the schema requires one.
   */
  link_path: string | null;
};

/** An article's identity: its URL key, who may read it, and where it sits. */
export type KbArticleRow = Omit<Tables["documents"]["Row"], "visibility"> &
  AddsToArticle & { visibility: ArticleVisibility };

/** One saved version of an article's text. */
export type KbArticleVersionRow = Omit<Tables["document_versions"]["Row"], "document_id"> & {
  article_id: string;
};

/** A private note or a shared comment, anchored to a block of a version. */
export type KbAnnotationRow = Omit<
  Tables["document_annotations"]["Row"],
  "visibility" | "document_id" | "document_version"
> & {
  visibility: AnnotationVisibility;
  article_id: string;
  article_version: number;
};

type TableDef<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

type PublicSchema = Database["public"];

/**
 * The generated database with the knowledge base tables under their new names.
 *
 * The three old names are omitted rather than left alongside: they do not exist
 * after the migration, and leaving them would let new code compile against a
 * table that is gone.
 */
export type KbDatabase = {
  public: Omit<PublicSchema, "Tables"> & {
    Tables: Omit<
      PublicSchema["Tables"],
      "documents" | "document_versions" | "document_annotations"
    > & {
      kb_sections: TableDef<KbSectionRow>;
      kb_articles: TableDef<KbArticleRow>;
      kb_article_versions: TableDef<KbArticleVersionRow>;
      kb_annotations: TableDef<KbAnnotationRow>;
    };
  };
};

export type KbClient = SupabaseClient<KbDatabase>;

/**
 * View the service-role client as one that knows the knowledge base tables.
 *
 * A cast, not a conversion: it is the same client either way. This exists so the
 * cast happens in ONE place with this comment attached to it, rather than being
 * sprinkled through the handlers where a reader would have to guess whether it
 * was load-bearing. It goes when the migration is applied and the generated
 * types carry the real names.
 */
export function asKbClient(client: SupabaseClient<Database>): KbClient {
  return client as unknown as KbClient;
}
