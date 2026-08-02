// Row/client types for club documents.
//
// These alias the GENERATED `integrations/supabase/types.ts`, which is derived
// from the live database, so a column that is renamed or dropped there fails the
// typecheck here rather than drifting quietly (see "Schema drift" in CLAUDE.md).
// They were hand-written while `20260731140000_documents.sql` was committed but
// unapplied; that migration is applied and the types regenerated, so the
// hand-written shapes are gone.
//
// The one narrowing: `visibility` is a text column with a CHECK, not an enum, so
// the generator can only say `string`. The app's own unions are the real values,
// and every read is filtered or compared against them, so they are asserted here
// in ONE place instead of being cast at each call site.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnnotationVisibility, DocumentVisibility } from "@/lib/documents";

type Tables = Database["public"]["Tables"];

/** A document's identity: its URL key and who may read it. */
export type DocumentRow = Omit<Tables["documents"]["Row"], "visibility"> & {
  visibility: DocumentVisibility;
};

/** One saved version of a document's text. */
export type DocumentVersionRow = Tables["document_versions"]["Row"];

/** A private note or a shared comment, anchored to a block of a version. */
export type DocumentAnnotationRow = Omit<Tables["document_annotations"]["Row"], "visibility"> & {
  visibility: AnnotationVisibility;
};

/**
 * The client the document code takes.
 *
 * A plain generated client — the document tables are in `types.ts` now, so
 * nothing has to be widened. Named rather than inlined so the handlers and the
 * test harness keep referring to one thing.
 */
export type DocumentClient = SupabaseClient<Database>;
