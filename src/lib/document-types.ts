// Row/client types for club documents.
//
// > [!IMPORTANT]
// > These row shapes are **provisional and hand-written**, which every other
// > `*-types.ts` module in this repo has stopped doing on purpose: the generated
// > `integrations/supabase/types.ts` is the only artifact derived from the LIVE
// > database, and a hand-written row that claims a column the live database
// > lacks hides schema drift from the compiler (see "Schema drift" in CLAUDE.md).
// >
// > They are here because the three tables do not exist live yet —
// > `20260731140000_documents.sql` is committed but unapplied, and committing a
// > migration does not apply it — so there is nothing for the generator to emit
// > and no honest alternative until it is.
// >
// > **When that migration has been applied and `types.ts` regenerated, delete
// > the shapes below and alias the generated ones**, exactly as
// > `membership-types.ts` and `profile-types.ts` record having done:
// >
// > ```ts
// > type Tables = Database["public"]["Tables"];
// > export type DocumentRow = Tables["documents"]["Row"];
// > ```
// >
// > Until then these are transcribed from that migration by hand and are only as
// > correct as this comment's author was.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnnotationVisibility, DocumentVisibility } from "@/lib/documents";

/** A document's identity: its URL key and who may read it. */
export type DocumentRow = {
  id: string;
  slug: string;
  visibility: DocumentVisibility;
  annotations_enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

/** One saved version of a document's text. */
export type DocumentVersionRow = {
  id: string;
  document_id: string;
  version: number;
  title: string;
  body_md: string;
  change_note: string | null;
  is_current: boolean;
  created_at: string;
  created_by: string | null;
};

/** A private note or a shared comment, anchored to a block of a version. */
export type DocumentAnnotationRow = {
  id: string;
  document_id: string;
  document_version: number;
  user_id: string;
  block_id: string | null;
  quote: string | null;
  visibility: AnnotationVisibility;
  parent_id: string | null;
  body: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
};

type TableDef<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

type PublicSchema = Database["public"];

/**
 * The generated database, widened with the three document tables.
 *
 * Additive only: every existing table keeps its generated definition, so this
 * cannot mask drift anywhere except in the tables it adds — which is the point,
 * and which stops mattering the moment they are generated for real.
 */
export type DocumentsDatabase = {
  public: Omit<PublicSchema, "Tables"> & {
    Tables: PublicSchema["Tables"] & {
      documents: TableDef<DocumentRow>;
      document_versions: TableDef<DocumentVersionRow>;
      document_annotations: TableDef<DocumentAnnotationRow>;
    };
  };
};

export type DocumentClient = SupabaseClient<DocumentsDatabase>;

/**
 * View the service-role client as one that knows about the document tables.
 *
 * A cast, not a conversion: it is the same client either way. This exists so the
 * cast happens in ONE place with this comment attached to it, rather than being
 * sprinkled through the handlers where a reader would have to guess whether it
 * was load-bearing.
 */
export function asDocumentClient(client: SupabaseClient<Database>): DocumentClient {
  return client as unknown as DocumentClient;
}
