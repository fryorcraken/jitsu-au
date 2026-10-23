// Promoting one stored version of a document to the live one, for every
// document the club keeps that way. See `document-versions.ts` for the pure half.
//
// Takes its client as a parameter, like the rest of the plain functions behind
// the server functions: a `createServerFn` handler cannot run in the test
// runner, and the manager agent API has to reach the same code the screens do.
//
// The hard part is one sequence, and it is the reason this file exists rather
// than one copy per document. Each table carries a partial unique index allowing
// exactly one `is_current = true`, so promoting is necessarily two writes with a
// gap between them: clear, then set. Nothing can close that gap from here --
// PostgREST gives each statement its own transaction -- so the job is to keep
// the gap short, never open it needlessly, and be loud when the club is left in
// it. An unnoticed gap is an outage: `/waiver` throws "No active waiver
// template" for every prospective member who submits.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DocumentVersionError } from "@/lib/document-versions";

/** The tables that hold a document in numbered versions with one live. */
export type VersionedTable = "waiver_templates";

/** Which document, and how to talk about it when promoting it goes wrong. */
export type VersionedDocument = {
  table: VersionedTable;
  /** What a manager calls it: "waiver". */
  noun: string;
  /** What having none live means for people, finishing "so ...": "nobody can sign". */
  withoutOne: string;
};

/**
 * Make one stored row the live one, and report honestly when it cannot.
 *
 * `refuse` is the document's own rule about what may go live, asked after the
 * row is known to exist and is not already live, and before anything is
 * written. It returns the refusal's message, or null to allow it. Both checks
 * happen BEFORE anything is cleared: a bad id, an already-live target or a
 * refused one must never cost the club its live version.
 */
export async function promoteDocumentVersion(
  admin: SupabaseClient<Database>,
  doc: VersionedDocument,
  id: string,
  refuse?: (row: Record<string, unknown>) => string | null,
): Promise<{ version: number }> {
  const { data: target, error: tErr } = await admin
    .from(doc.table)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (tErr) throw new DocumentVersionError(tErr.message, "not_published");
  if (!target)
    throw new DocumentVersionError(`That ${doc.noun} version no longer exists.`, "not_found");
  if (target.is_current) return { version: target.version };
  const refused = refuse?.(target);
  if (refused) throw new DocumentVersionError(refused, "invalid", target.version);

  const { data: previous, error: pErr } = await admin
    .from(doc.table)
    .select("id")
    .eq("is_current", true)
    .maybeSingle();
  if (pErr) throw new DocumentVersionError(pErr.message, "not_published", target.version);

  const { error: clearErr } = await admin
    .from(doc.table)
    .update({ is_current: false })
    .eq("is_current", true);
  if (clearErr) throw new DocumentVersionError(clearErr.message, "not_published", target.version);

  const { error: setErr } = await admin
    .from(doc.table)
    .update({ is_current: true })
    .eq("id", target.id);
  if (!setErr) return { version: target.version };

  // From here the club has no live version until something sets one.
  //
  // The likeliest cause is another manager promoting concurrently: they cleared
  // and set while we were between our own two writes, so our set hit the unique
  // index. That is not a broken database, it is a race with a winner — say so
  // in words a manager can act on rather than surfacing a constraint name.
  const { data: nowCurrent } = await admin
    .from(doc.table)
    .select("id")
    .eq("is_current", true)
    .maybeSingle();
  if (nowCurrent) {
    throw new DocumentVersionError(
      `Someone else changed the live ${doc.noun} a moment ago, so this change was not applied. Reload the page to see the current version.`,
      "not_published",
      target.version,
    );
  }

  if (previous) {
    const { error: restoreErr } = await admin
      .from(doc.table)
      .update({ is_current: true })
      .eq("id", previous.id);
    if (restoreErr) {
      // Both writes failed and nothing is live. This is the outage case, so it
      // gets a server-side log AND a message that tells the manager the page is
      // down rather than a generic failure they would shrug at.
      console.error(`[promote ${doc.table}] could not restore the live version:`, restoreErr);
      throw new DocumentVersionError(
        `The ${doc.noun} version could not be changed, and the club is now left with no live ${doc.noun}, so ${doc.withoutOne}. Try again now to fix it.`,
        "not_published",
        target.version,
      );
    }
  }
  throw new DocumentVersionError(setErr.message, "not_published", target.version);
}

/**
 * The number the next saved version gets.
 *
 * A failed read throws rather than starting again at 1: numbering a new version
 * 1 would collide with the existing version 1, and the manager's save would fail
 * on a duplicate-key message that says nothing about what actually went wrong.
 */
export async function nextDocumentVersion(
  admin: SupabaseClient<Database>,
  table: VersionedTable,
): Promise<number> {
  const { data, error } = await admin
    .from(table)
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new DocumentVersionError(error.message, "not_published");
  return (data?.version ?? 0) + 1;
}
