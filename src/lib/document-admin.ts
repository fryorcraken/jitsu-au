// Reading and writing club documents, with the client passed in.
//
// Split out of the server functions and the manager agent endpoint so both drive
// the same code — the agent API is the primary way managers edit documents, and
// a second implementation behind the web UI is how the two quietly stop agreeing
// about what "save" means. Taking the client as a parameter also makes the
// failure paths unit-testable, exactly as `promoteWaiverTemplate` and
// `applyCoverage` do: a `createServerFn` handler cannot run in the test runner.
import type { DocumentAnnotationRow, DocumentClient, DocumentRow } from "@/lib/document-types";
import type { DocumentVersionRow } from "@/lib/document-types";
import type { SaveDocumentInput } from "@/lib/validation";

/** A document together with the version being read. */
export type LoadedDocument = {
  document: DocumentRow;
  version: DocumentVersionRow;
};

/**
 * Make one version the live one, and report honestly when it cannot.
 *
 * The partial unique index allows exactly one `is_current = true` per document,
 * so this is necessarily two writes with a gap: clear, then set. Nothing can
 * close that gap from here — PostgREST gives each statement its own transaction
 * — so the job is to keep it short and be loud when a document is left in it.
 *
 * Directly modelled on `promoteWaiverTemplate`, including the recovery, with one
 * difference that matters: every write is scoped to ONE document_id. A clear
 * that forgot that scope would unpublish every other document in the club.
 */
export async function promoteDocumentVersion(
  db: DocumentClient,
  versionId: string,
): Promise<{ version: number }> {
  const { data: target, error: tErr } = await db
    .from("document_versions")
    .select("id, version, is_current, document_id")
    .eq("id", versionId)
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  // Both checks happen BEFORE anything is cleared: a bad id or an
  // already-current target must never cost the document its live version.
  if (!target) throw new Error("That document version no longer exists.");
  if (target.is_current) return { version: target.version };

  const { data: previous, error: pErr } = await db
    .from("document_versions")
    .select("id")
    .eq("document_id", target.document_id)
    .eq("is_current", true)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);

  const { error: clearErr } = await db
    .from("document_versions")
    .update({ is_current: false })
    .eq("document_id", target.document_id)
    .eq("is_current", true);
  if (clearErr) throw new Error(clearErr.message);

  const { error: setErr } = await db
    .from("document_versions")
    .update({ is_current: true })
    .eq("id", target.id);
  if (!setErr) return { version: target.version };

  // From here the document has no live version until something sets one. The
  // likeliest cause is a concurrent save: somebody else cleared and set while we
  // were between our two writes, so ours hit the unique index. That is a race
  // with a winner, not a broken database.
  const { data: nowCurrent } = await db
    .from("document_versions")
    .select("id")
    .eq("document_id", target.document_id)
    .eq("is_current", true)
    .maybeSingle();
  if (nowCurrent) {
    throw new Error(
      "Someone else published a version of this document a moment ago, so this change was not applied. Read it again before retrying.",
    );
  }

  if (previous) {
    const { error: restoreErr } = await db
      .from("document_versions")
      .update({ is_current: true })
      .eq("id", previous.id);
    if (restoreErr) {
      // Both writes failed and nothing is live: the document now 404s for every
      // reader. Log it, and say so in words rather than surfacing a constraint.
      console.error("[promoteDocumentVersion] could not restore the live version:", restoreErr);
      throw new Error(
        "The version could not be changed, and this document is now left with no published version, so nobody can read it. Try again now to fix it.",
      );
    }
  }
  throw new Error(setErr.message);
}

/**
 * Create or update a document, always as a NEW version.
 *
 * An unknown slug creates the document; a known one adds a version to it. That
 * is what makes the manager agent API usable without a separate "create" call:
 * an agent asked to publish the house rules does not have to know whether the
 * club already has a page for them.
 *
 * `visibility` and `annotations_enabled` are only written when supplied, so an
 * agent editing the text of a managers-only draft cannot publish it to the world
 * by omitting a field.
 */
export async function saveDocument(
  db: DocumentClient,
  input: SaveDocumentInput,
  actingAs: string | null,
): Promise<{ slug: string; version: number; document_id: string; created: boolean }> {
  const createdBy = actingAs && isUuid(actingAs) ? actingAs : null;

  const { data: existing, error: findErr } = await db
    .from("documents")
    .select("*")
    .eq("slug", input.slug)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  let document = existing as DocumentRow | null;
  const created = !document;

  if (!document) {
    const { data: inserted, error: insErr } = await db
      .from("documents")
      .insert({
        slug: input.slug,
        // The schema default is `members`, and it is repeated here rather than
        // left implicit: a document created through the API with no visibility
        // named should be members-only for a reason a reader of THIS code can
        // see, not because of a column default three files away.
        visibility: input.visibility ?? "members",
        annotations_enabled: input.annotations_enabled ?? true,
        created_by: createdBy,
      })
      .select("*")
      .single();
    if (insErr || !inserted) throw new Error(insErr?.message ?? "Could not create the document.");
    document = inserted as DocumentRow;
  } else {
    const patch: Partial<DocumentRow> = { updated_at: new Date().toISOString() };
    if (input.visibility !== undefined) patch.visibility = input.visibility;
    if (input.annotations_enabled !== undefined) {
      patch.annotations_enabled = input.annotations_enabled;
    }
    const { data: updated, error: updErr } = await db
      .from("documents")
      .update(patch)
      .eq("id", document.id)
      .select("*")
      .single();
    if (updErr || !updated) throw new Error(updErr?.message ?? "Could not update the document.");
    document = updated as DocumentRow;
  }

  // A failed read here would number the new version 1 and collide with the
  // existing version 1, so the save would fail on a duplicate-key message that
  // says nothing about what went wrong. (Same guard as `saveWaiverTemplate`.)
  const { data: maxRow, error: maxErr } = await db
    .from("document_versions")
    .select("version")
    .eq("document_id", document.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) throw new Error(maxErr.message);
  const nextVersion = (maxRow?.version ?? 0) + 1;

  // Write the new version as a draft, THEN promote it. The obvious order (clear
  // `is_current`, then insert the row already current) leaves the document
  // unreadable if the insert fails, with nothing to roll back to. This way a
  // failed insert changes nothing, and a failed promotion leaves the previous
  // version live with an unused draft behind it.
  const { data: createdVersion, error: verErr } = await db
    .from("document_versions")
    .insert({
      document_id: document.id,
      version: nextVersion,
      title: input.title,
      body_md: input.body_md,
      change_note: input.change_note || null,
      is_current: false,
      created_by: createdBy,
    })
    .select("id, version")
    .single();
  if (verErr || !createdVersion) {
    throw new Error(verErr?.message ?? "Could not save the document version.");
  }

  await promoteDocumentVersion(db, createdVersion.id);
  return {
    slug: document.slug,
    version: createdVersion.version,
    document_id: document.id,
    created,
  };
}

/**
 * Load a document by slug, with one version: the live one, or a named one.
 *
 * Returns null when the document does not exist. A document that exists but has
 * no published version also returns null — from a reader's point of view there
 * is nothing to show, and every caller would otherwise have to invent the same
 * answer for a state only a half-failed save can produce.
 */
export async function loadDocument(
  db: DocumentClient,
  slug: string,
  version?: number,
): Promise<LoadedDocument | null> {
  const { data: document, error: docErr } = await db
    .from("documents")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (docErr) throw new Error(docErr.message);
  if (!document) return null;

  let query = db.from("document_versions").select("*").eq("document_id", document.id);
  query = version === undefined ? query.eq("is_current", true) : query.eq("version", version);
  const { data: versionRow, error: verErr } = await query.maybeSingle();
  if (verErr) throw new Error(verErr.message);
  if (!versionRow) return null;

  return { document: document as DocumentRow, version: versionRow as DocumentVersionRow };
}

/** The document shape the API and the reader both return. */
export function projectDocument({ document, version }: LoadedDocument) {
  return {
    slug: document.slug,
    title: version.title,
    body_md: version.body_md,
    version: version.version,
    is_current_version: version.is_current,
    change_note: version.change_note,
    visibility: document.visibility,
    annotations_enabled: document.annotations_enabled,
    updated_at: version.created_at,
  };
}

/** An annotation as the manager API reports it. */
export function projectAnnotation(row: DocumentAnnotationRow, authorName: string | null) {
  return {
    id: row.id,
    author: authorName,
    author_user_id: row.user_id,
    visibility: row.visibility,
    document_version: row.document_version,
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
