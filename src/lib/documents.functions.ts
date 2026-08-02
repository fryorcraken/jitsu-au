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
import { listSharedAnnotations, loadDocument, projectDocument } from "@/lib/document-admin";
import type { DocumentAnnotationRow, DocumentClient, DocumentRow } from "@/lib/document-types";
import {
  commentDisplayName,
  createAnnotationSchema,
  deleteAnnotationSchema,
  documentSlugSchema,
  getDocumentSchema,
  nameWithPreferred,
  readDocumentSchema,
  resolveAnnotationSchema,
  saveDocumentSchema,
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
  return supabaseAdmin;
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
 *
 * `strict` changes what a FAILURE means, not what a valid answer is. Degrading
 * to signed-out is right for a reader (they get the public view of a public
 * page), and wrong for a manager screen: a momentary Supabase hiccup would
 * demote a real manager to "not a manager", and the resulting `Forbidden` is
 * indistinguishable from "you are not allowed", so the screen would tell them
 * they have no documents. In strict mode a failed identity or role lookup is
 * raised as itself.
 */
async function resolveViewer(db: DocumentClient, opts: { strict?: boolean } = {}): Promise<Viewer> {
  const getHeader = await headerGetter();
  const bearer = getHeader("authorization")?.replace(/^Bearer\s+/i, "") || null;
  if (!bearer) return { userId: null, isManager: false };

  const unavailable = new Error(
    "Could not confirm who you are just now. Reload the page and try again.",
  );

  let userId: string | null = null;
  try {
    const { data, error } = await db.auth.getUser(bearer);
    // An `error` here is ambiguous: an expired token and an unreachable auth
    // service look the same. Signed-out is the safe read for a public page, and
    // the wrong one for a manager screen — hence `strict`.
    if (error && opts.strict) throw unavailable;
    userId = data.user?.id ?? null;
  } catch (e) {
    if (opts.strict) throw e === unavailable ? e : unavailable;
    return { userId: null, isManager: false };
  }
  if (!userId) return { userId: null, isManager: false };

  try {
    const { data: isManager, error } = await db.rpc("has_role", {
      _user_id: userId,
      _role: "manager",
    });
    // A failed role lookup is not "not a manager". Under `strict` it must not be
    // reported as one.
    if (error && opts.strict) throw unavailable;
    return { userId, isManager: Boolean(isManager) };
  } catch (e) {
    if (opts.strict) throw e === unavailable ? e : unavailable;
    return { userId, isManager: false };
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

/** The columns both index queries select. Narrower than `DocumentRow` on purpose. */
type DocumentListRow = Pick<
  DocumentRow,
  "id" | "slug" | "visibility" | "annotations_enabled" | "updated_at"
>;

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

  // Cast to exactly what the `.select()` asked for, not to the whole row: a
  // `DocumentRow[]` here would promise `created_by` and `created_at`, which were
  // never fetched, so reading one would typecheck and be `undefined`.
  const readable = ((docs ?? []) as DocumentListRow[]).filter((d) =>
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

/**
 * Display names for a set of authors, so member-facing comments are not
 * signed with UUIDs.
 *
 * Uses `commentDisplayName` (the same public/member-facing name policy as
 * blog comments) rather than the legal name: a shared comment can be as
 * visible as a blog comment (readable by every member, or by anyone on a
 * `public` document), so it's signed with the member's chosen display name,
 * else "preferred/first name + last initial" — enough to tell two "Ada"s
 * apart without publishing a full legal name. Manager-facing views use
 * `managerAuthorNames` instead.
 */
export async function authorNames(
  db: DocumentClient,
  userIds: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return new Map();
  const { data, error } = await db
    .from("profiles")
    .select("user_id, first_name, last_name, preferred_name, display_name")
    .in("user_id", unique);
  // A failed name lookup must not take the whole thread down: comments still
  // read fine signed "Someone at the club", and the alternative is a page that
  // shows nothing at all because one join failed.
  if (error) {
    console.error("[documents] author name lookup failed:", error);
    return new Map();
  }
  return new Map((data ?? []).map((p) => [p.user_id, commentDisplayName(p)]));
}

/**
 * Display names for a set of authors, for a MANAGER-facing list — the full
 * legal name (`nameWithPreferred`), the same convention the manager agent
 * API's `list_document_annotations` and every other manager screen (check-in,
 * membership, club-users, waivers, calendar) already use: a manager needs to
 * identify who wrote a comment for moderation. Not `authorNames`, which is
 * member-facing and deliberately withholds the legal name.
 */
export async function managerAuthorNames(
  db: DocumentClient,
  userIds: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return new Map();
  const { data, error } = await db
    .from("profiles")
    .select("user_id, first_name, middle_name, last_name, preferred_name")
    .in("user_id", unique);
  if (error) {
    console.error("[documents] manager author name lookup failed:", error);
    return new Map();
  }
  return new Map((data ?? []).map((p) => [p.user_id, nameWithPreferred(p) || null]));
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

// ---------------------------------------------------------------------------
// Manager screens (`/manager/documents`)
//
// The same operations the manager agent API exposes, reached from the site
// instead of a bearer token. Both drive `document-admin.ts`, so "save" means one
// thing however it was asked for — a second implementation behind the web UI is
// how the two quietly stop agreeing.
//
// Each of these gates on `isManager` itself. The `_authenticated` route group
// only proves somebody is signed in, and the client-side redirect on the page is
// a courtesy, not a lock.
// ---------------------------------------------------------------------------

/**
 * Cap on documents the manager list returns. A club with more pages than this
 * has outgrown a flat sidebar; the handler warns rather than truncating in
 * silence.
 */
const MANAGER_DOCUMENTS_LIMIT = 500;

/**
 * Fail unless the caller holds the manager role.
 *
 * Strict: on a manager screen, "we could not check" must not arrive as
 * "Forbidden". The page suppresses `Forbidden` (a non-manager is being
 * redirected anyway), so a swallowed lookup failure would leave a real manager
 * staring at an empty documents list with no error to act on.
 */
async function requireManagerViewer(db: DocumentClient): Promise<Viewer> {
  const viewer = await resolveViewer(db, { strict: true });
  if (!viewer.isManager) throw new Error("Forbidden");
  return viewer;
}

/**
 * Every document, for the manager list — drafts included.
 *
 * Unlike `listDocuments`, this does NOT filter by visibility: a manager is the
 * audience for the managers-only drafts. It also reports documents with no
 * published version, which the member-facing list skips, because that state is
 * exactly what a manager needs to see and fix.
 */
export const listManagerDocuments = createServerFn({ method: "GET" }).handler(async () => {
  const db = await adminClient();
  await requireManagerViewer(db);

  const { data: docs, error } = await db
    .from("documents")
    .select("id, slug, visibility, annotations_enabled, created_at, updated_at")
    .order("slug")
    .limit(MANAGER_DOCUMENTS_LIMIT);
  if (error) throw new Error(error.message);
  const documents = (docs ?? []) as DocumentListRow[];
  if (documents.length >= MANAGER_DOCUMENTS_LIMIT) {
    console.warn(
      `[documents] manager list capped at ${MANAGER_DOCUMENTS_LIMIT}; some documents are not shown`,
    );
  }
  if (!documents.length) return [];

  const ids = documents.map((d) => d.id);
  const { data: live, error: lErr } = await db
    .from("document_versions")
    .select("document_id, title, version, created_at, change_note")
    .in("document_id", ids)
    .eq("is_current", true);
  if (lErr) throw new Error(lErr.message);

  // Count versions IN the database, one `head: true` count per document.
  //
  // Reading every version row just to length them in JS grows without bound —
  // every save adds one — and would eventually be truncated by the server-side
  // row cap. That truncation is silent and unordered, so a document would
  // quietly report "Version 12 of 74" when it has 90: a confident wrong number,
  // which is the failure `handleListUsers` in the agent endpoint exists to warn
  // about. These counts transfer no rows.
  const liveByDoc = new Map((live ?? []).map((v) => [v.document_id, v]));
  const countByDoc = new Map<string, number>();
  await Promise.all(
    documents.map(async (d) => {
      const { count, error: cErr } = await db
        .from("document_versions")
        .select("*", { count: "exact", head: true })
        .eq("document_id", d.id);
      if (cErr) throw new Error(cErr.message);
      countByDoc.set(d.id, count ?? 0);
    }),
  );

  return documents.map((d) => {
    const current = liveByDoc.get(d.id);
    return {
      slug: d.slug,
      // Null when a save half-failed and left the document with no live
      // version. Surfaced rather than hidden — the manager is who fixes it.
      title: current?.title ?? null,
      version: current?.version ?? null,
      versions: countByDoc.get(d.id) ?? 0,
      visibility: d.visibility,
      annotations_enabled: d.annotations_enabled,
      change_note: current?.change_note ?? null,
      updated_at: current?.created_at ?? d.updated_at,
    };
  });
});

/** One document for the editor: the live version, or a named one. Managers only. */
export const getManagerDocument = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => getDocumentSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    await requireManagerViewer(db);
    const loaded = await loadDocument(db, data.slug, data.version);
    if (!loaded) throw new Error("No such document, or no such version.");
    return projectDocument(loaded);
  });

/** Every version of a document, newest first. Managers only. */
export const listDocumentVersions = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ slug: documentSlugSchema }).parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    await requireManagerViewer(db);

    const { data: doc, error: docErr } = await db
      .from("documents")
      .select("id")
      .eq("slug", data.slug)
      .maybeSingle();
    if (docErr) throw new Error(docErr.message);
    if (!doc) throw new Error("No such document.");

    const { data: rows, error } = await db
      .from("document_versions")
      .select("id, version, title, change_note, is_current, created_at")
      .eq("document_id", doc.id)
      .order("version", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/**
 * Save a document from the editor: creates it if the slug is new, otherwise adds
 * a version and publishes it. Straight through to the same `saveDocument` the
 * agent API calls.
 */
export const saveManagerDocument = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => saveDocumentSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await requireManagerViewer(db);
    const { saveDocument } = await import("@/lib/document-admin");
    return saveDocument(db, data, viewer.userId);
  });

/**
 * Publish an existing version — the rollback path.
 *
 * Separate from saving because it publishes a version that already exists rather
 * than writing a new one, which is how a manager undoes an edit without
 * retyping the version they want back.
 */
export const setCurrentDocumentVersion = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    await requireManagerViewer(db);
    const { promoteDocumentVersion } = await import("@/lib/document-admin");
    const { version } = await promoteDocumentVersion(db, data.id);
    return { ok: true as const, version };
  });

/**
 * The SHARED feedback on a document, for the manager reading it back.
 *
 * Shared only, and that is not an oversight to be fixed later: a private note is
 * private from the club too (see the migration), which is what makes it usable
 * for "things I want to remember". A manager gets the conversation, never
 * somebody's notebook — the same rule `list_document_annotations` follows on the
 * agent API.
 */
export const listManagerAnnotations = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ slug: documentSlugSchema, include_resolved: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await requireManagerViewer(db);

    const { data: doc, error: docErr } = await db
      .from("documents")
      .select("id")
      .eq("slug", data.slug)
      .maybeSingle();
    if (docErr) throw new Error(docErr.message);
    if (!doc) throw new Error("No such document.");

    const annotations = await listSharedAnnotations(db, doc.id, {
      includeResolved: data.include_resolved,
      limit: ANNOTATIONS_LIMIT,
    });
    const names = await managerAuthorNames(
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
      is_mine: a.user_id === viewer.userId,
      can_edit: canEditAnnotation(a, viewer),
      can_resolve: canResolveThread(a, viewer),
      resolved_at: a.resolved_at,
      created_at: a.created_at,
      updated_at: a.updated_at,
    }));
  });
