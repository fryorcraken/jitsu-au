// Server functions for reading club documents and annotating them.
//
// Every handler runs on the SERVICE ROLE and enforces visibility in code (via
// `canReadDocument` / `canAnnotate` in `@/lib/documents`), rather than granting
// the client roles anything and leaning on RLS. That is the shape almost
// everything in this app already has, and it is what keeps
// `supabase/lint/client-grants-expected.txt` empty of document tables: the
// policies in the migration are defence in depth, not the live gate.
//
// The service-role client is lazy-imported inside each handler — this file is
// bundled to the client, so a top-level import would ship the key.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  ANNOTATIONS_LIMIT,
  annotationReadFilter,
  canAnnotate,
  canEditAnnotation,
  canReadDocument,
  canResolveThread,
} from "@/lib/documents";
import type { AnnotationVisibility, Viewer } from "@/lib/documents";
import { loadDocument, projectDocument } from "@/lib/document-admin";
import { asDocumentClient } from "@/lib/document-types";
import type { DocumentAnnotationRow, DocumentClient, DocumentRow } from "@/lib/document-types";
import {
  createAnnotationSchema,
  deleteAnnotationSchema,
  greetingName,
  readDocumentSchema,
  resolveAnnotationSchema,
  updateAnnotationSchema,
} from "@/lib/validation";

/** Request headers, when the server runtime exposes them. Never throws. */
async function headerGetter(): Promise<(name: string) => string | undefined> {
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return (name: string) => getRequestHeader(name);
  } catch {
    return () => undefined;
  }
}

async function adminClient(): Promise<DocumentClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return asDocumentClient(supabaseAdmin);
}

/**
 * Who is asking, resolved from the request's bearer token.
 *
 * Deliberately NOT the `requireSupabaseAuth` middleware: a public document has
 * to render for a signed-out visitor, so "nobody" is a valid answer here rather
 * than a 401. Handlers that genuinely need a person say so themselves by
 * throwing on `viewer.userId === null`.
 *
 * An expired or junk token resolves to the same signed-out viewer as no token
 * at all — the reader sees the public view rather than an error about a session
 * they cannot do anything about.
 */
async function resolveViewer(db: DocumentClient): Promise<Viewer> {
  const getHeader = await headerGetter();
  const bearer = getHeader("authorization")?.replace(/^Bearer\s+/i, "") || null;
  if (!bearer) return { userId: null, isManager: false };

  try {
    const { data } = await db.auth.getUser(bearer);
    const userId = data.user?.id ?? null;
    if (!userId) return { userId: null, isManager: false };
    const { data: isManager } = await db.rpc("has_role", {
      _user_id: userId,
      _role: "manager",
    });
    return { userId, isManager: Boolean(isManager) };
  } catch {
    return { userId: null, isManager: false };
  }
}

/**
 * Refuse in the same words whether a document is missing or merely not for this
 * reader.
 *
 * Managers keep drafts here (`visibility = 'managers'`), and a distinct "you are
 * not allowed to see this" would confirm the existence and slug of every one of
 * them to anyone who guessed a URL.
 */
const NOT_FOUND = "That document does not exist, or is not available to you.";

/**
 * Read one document, always the LIVE version.
 *
 * A reader cannot ask for an older version, and that is a security boundary
 * rather than a missing feature: `visibility` lives on the document, not on each
 * version, so honouring a `version` parameter here would hand every member the
 * drafting history of any document that was once managers-only and has since
 * been published. See `readDocumentSchema`.
 */
export const getDocument = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => readDocumentSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await resolveViewer(db);
    const loaded = await loadDocument(db, data.slug);
    if (!loaded) throw new Error(NOT_FOUND);
    if (!canReadDocument(loaded.document.visibility, viewer)) throw new Error(NOT_FOUND);

    return {
      document: projectDocument(loaded),
      viewer: {
        signed_in: Boolean(viewer.userId),
        user_id: viewer.userId,
        is_manager: viewer.isManager,
        can_annotate: canAnnotate(loaded.document, viewer),
      },
    };
  });

/** The documents this reader may see, for an index page. */
export const listDocuments = createServerFn({ method: "GET" }).handler(async () => {
  const db = await adminClient();
  const viewer = await resolveViewer(db);

  const { data: docs, error } = await db
    .from("documents")
    .select("id, slug, visibility, annotations_enabled, updated_at")
    .order("slug");
  if (error) throw new Error(error.message);

  const readable = ((docs ?? []) as DocumentRow[]).filter((d) =>
    canReadDocument(d.visibility, viewer),
  );
  if (!readable.length) return [];

  // Titles live on the version, not the document, so an index needs the live
  // version of each. One query for all of them, filtered in code — a per-document
  // round trip would scale with the club's document count for no benefit.
  const { data: versions, error: vErr } = await db
    .from("document_versions")
    .select("document_id, title, version, created_at")
    .in(
      "document_id",
      readable.map((d) => d.id),
    )
    .eq("is_current", true);
  if (vErr) throw new Error(vErr.message);

  const liveByDoc = new Map((versions ?? []).map((v) => [v.document_id, v]));
  return readable
    .map((d) => {
      const live = liveByDoc.get(d.id);
      // A document whose save half-failed has no live version. Skip it rather
      // than listing a link that 404s.
      if (!live) return null;
      return {
        slug: d.slug,
        title: live.title,
        version: live.version,
        visibility: d.visibility,
        updated_at: live.created_at,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
});

/**
 * Load a document and check the caller may read it, or throw. The shared first
 * half of every annotation handler.
 */
async function requireReadableDocument(db: DocumentClient, slug: string, viewer: Viewer) {
  const loaded = await loadDocument(db, slug);
  if (!loaded) throw new Error(NOT_FOUND);
  if (!canReadDocument(loaded.document.visibility, viewer)) throw new Error(NOT_FOUND);
  return loaded;
}

/** Display names for a set of authors, so comments are not signed with UUIDs. */
async function authorNames(
  db: DocumentClient,
  userIds: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return new Map();
  const { data, error } = await db
    .from("profiles")
    .select("user_id, first_name, middle_name, last_name, preferred_name")
    .in("user_id", unique);
  // A failed name lookup must not take the whole thread down: comments still
  // read fine signed "Someone at the club", and the alternative is a page that
  // shows nothing at all because one join failed.
  if (error) {
    console.error("[documents] author name lookup failed:", error);
    return new Map();
  }
  return new Map((data ?? []).map((p) => [p.user_id, greetingName(p) || null]));
}

/**
 * The annotations on a document that this reader is allowed to see: their own
 * (private included) plus everyone's shared ones.
 *
 * The privacy rule is applied in the QUERY, not after it — an `.or()` filter
 * rather than fetching everything and dropping rows in JavaScript — so a bug in
 * a later map cannot leak somebody's private notes into the payload.
 */
export const listAnnotations = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ slug: z.string().trim().max(100) }).parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await resolveViewer(db);
    const loaded = await requireReadableDocument(db, data.slug, viewer);

    let query = db
      .from("document_annotations")
      .select("*")
      .eq("document_id", loaded.document.id)
      .order("created_at", { ascending: true })
      .limit(ANNOTATIONS_LIMIT);
    const filter = annotationReadFilter(viewer);
    query =
      filter.mode === "shared-or-own"
        ? query.or(filter.orExpression)
        : query.eq("visibility", "shared");

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    const annotations = (rows ?? []) as DocumentAnnotationRow[];
    // Truncation here is not cosmetic: the read is ordered oldest-first, so the
    // rows dropped are the NEWEST, and a reply whose root survived while it did
    // not gets promoted to a bogus top-level comment by `groupThreads`. Say so
    // rather than rendering a quietly wrong thread.
    if (annotations.length >= ANNOTATIONS_LIMIT) {
      console.warn(
        `[documents] annotations on "${data.slug}" capped at ${ANNOTATIONS_LIMIT}; newest comments and their threads are truncated`,
      );
    }
    const names = await authorNames(
      db,
      annotations.map((a) => a.user_id),
    );

    return annotations.map((a) => ({
      id: a.id,
      body: a.body,
      visibility: a.visibility,
      block_id: a.block_id,
      quote: a.quote,
      parent_id: a.parent_id,
      document_version: a.document_version,
      author: names.get(a.user_id) ?? null,
      // No `author_user_id`: the UI never needs it (ownership arrives
      // precomputed below), and shipping it would hand every member the auth
      // UUID of everyone who has ever commented, for nothing.
      /** Precomputed so the UI never has to know the ownership rules. */
      is_mine: a.user_id === viewer.userId,
      can_edit: canEditAnnotation(a, viewer),
      can_resolve: canResolveThread(a, viewer),
      resolved_at: a.resolved_at,
      created_at: a.created_at,
      updated_at: a.updated_at,
    }));
  });

/** Write an annotation: a private note, a new shared thread, or a reply. */
export const createAnnotation = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => createAnnotationSchema.parse(d))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, id: null };

    const db = await adminClient();
    const viewer = await resolveViewer(db);
    if (!viewer.userId) throw new Error("Please sign in to comment on this document.");

    const loaded = await requireReadableDocument(db, data.slug, viewer);
    if (!canAnnotate(loaded.document, viewer)) {
      throw new Error("This document is not accepting comments.");
    }

    // A person must exist in `profiles` before they can annotate: the column is
    // a foreign key to it, and someone whose auth user predates their profile
    // would otherwise get a raw constraint error.
    const { data: profile, error: profErr } = await db
      .from("profiles")
      .select("user_id")
      .eq("user_id", viewer.userId)
      .maybeSingle();
    if (profErr) throw new Error(profErr.message);
    if (!profile) {
      throw new Error("Your club record is not set up yet, so comments are not available.");
    }

    const visibility: AnnotationVisibility = data.visibility;
    let blockId = data.block_id || null;
    let quote = data.quote || null;

    if (data.parent_id) {
      // Refuse a private reply rather than publishing it.
      //
      // This used to overwrite `visibility` with "shared", which took a request
      // that said "keep this to myself" and posted it to a thread everyone
      // reads. Today's UI always sends "shared" here, so it was unreachable from
      // the app — but this is a public RPC, and every other override in this
      // block fails closed. The one field the whole feature rests on must not be
      // the exception. (The DB CHECK `document_annotations_private_has_no_parent`
      // would have caught it, but only because the overwrite happened first.)
      if (visibility === "private") {
        throw new Error("A private note cannot be a reply. Post it on the passage instead.");
      }
      const { data: parent, error: parentErr } = await db
        .from("document_annotations")
        .select("*")
        .eq("id", data.parent_id)
        .maybeSingle();
      if (parentErr) throw new Error(parentErr.message);
      const parentRow = parent as DocumentAnnotationRow | null;
      // A reply must be on a shared thread of THIS document, and threads are one
      // level deep. Replying to a private note is refused rather than quietly
      // converted: the note's author never published it, and the DB CHECK only
      // catches half of this (a private row with a parent), not a reply that
      // names a private parent.
      if (!parentRow || parentRow.document_id !== loaded.document.id) {
        throw new Error("The comment you replied to no longer exists.");
      }
      if (parentRow.visibility !== "shared") {
        throw new Error("That comment cannot be replied to.");
      }
      if (parentRow.parent_id) {
        throw new Error("Replies cannot be replied to. Reply to the original comment instead.");
      }
      // A reply inherits its thread's anchor so it can never drift onto a
      // different passage. Visibility is NOT inherited — it is checked above,
      // so a reply is already known to be shared.
      blockId = parentRow.block_id;
      quote = parentRow.quote;
    }

    const { data: inserted, error } = await db
      .from("document_annotations")
      .insert({
        document_id: loaded.document.id,
        // The version the READER had on screen, not the live one. They may be
        // different (someone published while the page was open), and what the
        // comment was about is the version that was read.
        document_version: data.document_version,
        user_id: viewer.userId,
        block_id: blockId,
        quote,
        visibility,
        parent_id: data.parent_id ?? null,
        body: data.body,
      })
      .select("id, created_at")
      .single();
    if (error || !inserted) throw new Error(error?.message ?? "Could not save your comment.");
    return { ok: true as const, id: inserted.id, created_at: inserted.created_at };
  });

/** Edit your own annotation's text. */
export const updateAnnotation = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => updateAnnotationSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await resolveViewer(db);
    if (!viewer.userId) throw new Error("Please sign in.");

    const { data: existing, error: findErr } = await db
      .from("document_annotations")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    const row = existing as DocumentAnnotationRow | null;
    if (!row) throw new Error("That comment no longer exists.");
    // Authors only, managers included — see `canEditAnnotation`.
    if (!canEditAnnotation(row, viewer)) throw new Error("You can only edit your own comments.");

    const { error } = await db
      .from("document_annotations")
      .update({ body: data.body, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/**
 * Delete your own annotation.
 *
 * A manager may also delete a SHARED one, which is moderation: taking an abusive
 * comment off a page everyone reads. Private notes are never deletable by anyone
 * but their author, since nobody else can read them in the first place.
 */
export const deleteAnnotation = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => deleteAnnotationSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await resolveViewer(db);
    if (!viewer.userId) throw new Error("Please sign in.");

    const { data: existing, error: findErr } = await db
      .from("document_annotations")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    const row = existing as DocumentAnnotationRow | null;
    if (!row) return { ok: true as const };

    const mine = canEditAnnotation(row, viewer);
    const moderating = viewer.isManager && row.visibility === "shared";
    if (!mine && !moderating) throw new Error("You can only delete your own comments.");

    // Replies cascade with their root (ON DELETE CASCADE), so deleting a thread
    // takes the conversation with it. That is the intended behaviour for
    // moderation, and the UI warns before doing it.
    const { error } = await db.from("document_annotations").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** Resolve or reopen a shared thread. */
export const resolveAnnotation = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => resolveAnnotationSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await resolveViewer(db);
    if (!viewer.userId) throw new Error("Please sign in.");

    const { data: existing, error: findErr } = await db
      .from("document_annotations")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    const row = existing as DocumentAnnotationRow | null;
    if (!row) throw new Error("That comment no longer exists.");
    if (!canResolveThread(row, viewer)) {
      throw new Error("Only the author or a manager can resolve this thread.");
    }

    const { error } = await db
      .from("document_annotations")
      .update({
        resolved_at: data.resolved ? new Date().toISOString() : null,
        resolved_by: data.resolved ? viewer.userId : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const, resolved: data.resolved };
  });
