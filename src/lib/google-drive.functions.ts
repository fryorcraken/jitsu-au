import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { type DriveFolderSource, FOLDER_MIME_TYPE } from "@/lib/google-drive.constants";
import { profileFullName } from "@/lib/validation";

const GATEWAY_BASE_URL = "https://connector-gateway.lovable.dev";
const CONNECTOR_ID = "google_drive";
export const DEFAULT_FOLDER_NAME = "UTS Jitsu Waivers";
const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
];

type AuthCtx = {
  supabase: { rpc: typeof import("@/integrations/supabase/client").supabase.rpc };
  userId: string;
};
async function requireManager(ctx: AuthCtx) {
  const { data, error } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

// ---- Start OAuth: return authorizationUrl for the popup ----
export const startGoogleDriveConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((targetOrigin: unknown) => z.string().url().parse(targetOrigin))
  .handler(async ({ data: targetOrigin, context }) => {
    await requireManager(context);
    const clientKey = process.env.GOOGLE_DRIVE_APP_USER_CONNECTOR_CLIENT_API_KEY;
    if (!clientKey) throw new Error("Google Drive connector is not configured.");
    const { authorizeAppUserOAuth } = await import("@/integrations/lovable/appUserConnector");
    const { authorizationUrl } = await authorizeAppUserOAuth({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectorId: CONNECTOR_ID,
      appUserId: context.userId,
      clientAPIKey: clientKey,
      returnUrl: `${targetOrigin}/account`,
      responseMode: "web_message",
      webMessageTargetOrigin: targetOrigin,
      credentialsConfiguration: { scopes: SCOPES },
    });
    return { authorizationUrl };
  });

// ---- Save the resulting connection key ----
export const saveGoogleDriveConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ connectionAPIKey: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { saveConnectionForUser } = await import("./app-user-connections.server");
    const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");

    // Fetch the connected Google account email for display.
    let email: string | null = null;
    try {
      const res = await callAsAppUser({
        gatewayBaseUrl: GATEWAY_BASE_URL,
        connectionAPIKey: data.connectionAPIKey,
        connectorId: CONNECTOR_ID,
        path: "/drive/v3/about?fields=user(emailAddress)",
      });
      if (res.ok) {
        const body = (await res.json()) as { user?: { emailAddress?: string } };
        email = body.user?.emailAddress ?? null;
      }
    } catch {
      /* non-fatal */
    }

    await saveConnectionForUser({
      userId: context.userId,
      connectorId: CONNECTOR_ID,
      connectionAPIKey: data.connectionAPIKey,
      connectedEmail: email,
      metadata: {},
    });
    return { ok: true as const, email };
  });

// ---- Status: is Google Drive connected, and which folder is configured? ----
export const getGoogleDriveStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { getConnectionForUser } = await import("./app-user-connections.server");
    const conn = await getConnectionForUser(context.userId, CONNECTOR_ID);
    if (!conn) return { connected: false as const };
    return {
      connected: true as const,
      email: conn.connectedEmail,
      folderId: (conn.metadata.folderId as string | undefined) ?? null,
      folderName: (conn.metadata.folderName as string | undefined) ?? null,
    };
  });

// ---- Set (or change) the manager's Drive destination folder ----
// Resolved once here, by name (search-or-create), rather than lazily on every
// waiver save. `uploadWaiverToDrive` then just reuses the cached folder id.
export const setGoogleDriveFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ folderName: z.string().trim().min(1).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { getConnectionForUser, updateConnectionMetadata } =
      await import("./app-user-connections.server");
    const conn = await getConnectionForUser(context.userId, CONNECTOR_ID);
    if (!conn) throw new Error("Connect your Google account first.");

    const folderId = await ensureFolder(conn.connectionAPIKey, data.folderName);
    await updateConnectionMetadata(context.userId, CONNECTOR_ID, {
      ...conn.metadata,
      folderId,
      folderName: data.folderName,
      folderSource: "name" satisfies DriveFolderSource,
    });
    return { ok: true as const, folderId, folderName: data.folderName };
  });

// ---- Resolve a Picker-selected folder id to its canonical name ----
// Exported as a plain function (fetch injected) so it's testable without a
// `createServerFn` context — see checkin.functions.ts's `applyCoverage` for
// the same pattern. The id came from a folder the manager granted this app
// access to via Picker under the connector's own OAuth client, so there's no
// name-based search-or-create to do here (see ensureFolder). What's left is
// confirming the server-side connection can actually see it — catches a
// folder picked under a different Google account than the one connected —
// and reading back its canonical name rather than trusting whatever the
// picker UI displayed.
export async function resolvePickedFolder(
  fetchFolder: (folderId: string) => Promise<Response>,
  folderId: string,
): Promise<{ id: string; name: string }> {
  const res = await fetchFolder(folderId);
  if (!res.ok) {
    throw new Error(
      "Could not access that folder from the server. Pick it while signed into the same Google account you connected.",
    );
  }
  const found = (await res.json()) as { id: string; name?: string; mimeType?: string };
  if (found.mimeType !== FOLDER_MIME_TYPE) {
    throw new Error("That isn't a folder.");
  }
  return { id: found.id, name: found.name ?? "Untitled folder" };
}

// ---- Set the manager's Drive destination folder from a Google Picker pick ----
export const setGoogleDriveFolderFromPicker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ folderId: z.string().trim().min(1).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { getConnectionForUser, updateConnectionMetadata } =
      await import("./app-user-connections.server");
    const conn = await getConnectionForUser(context.userId, CONNECTOR_ID);
    if (!conn) throw new Error("Connect your Google account first.");

    const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
    let folder;
    try {
      folder = await resolvePickedFolder(
        (folderId) =>
          callAsAppUser({
            gatewayBaseUrl: GATEWAY_BASE_URL,
            connectionAPIKey: conn.connectionAPIKey,
            connectorId: CONNECTOR_ID,
            // `supportsAllDrives` is required for anything living in a shared
            // (team) drive: without it Drive answers 404 for a folder the
            // connection can genuinely reach, which would read here as "wrong
            // Google account".
            path: `/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`,
          }),
        data.folderId,
      );
    } catch (e) {
      // The client sees a friendly "same Google account" message either way;
      // this keeps the real cause (a genuine permission mismatch vs. a
      // transient Drive API error) visible to whoever reads server logs.
      console.error("[setGoogleDriveFolderFromPicker] resolvePickedFolder failed:", e);
      throw e;
    }

    await updateConnectionMetadata(context.userId, CONNECTOR_ID, {
      ...conn.metadata,
      folderId: folder.id,
      folderName: folder.name,
      folderSource: "picker" satisfies DriveFolderSource,
    });
    return { ok: true as const, folderId: folder.id, folderName: folder.name };
  });

// ---- Disconnect ----
export const disconnectGoogleDrive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { getConnectionForUser, deleteConnectionForUser } =
      await import("./app-user-connections.server");
    const conn = await getConnectionForUser(context.userId, CONNECTOR_ID);
    if (conn) {
      try {
        const { disconnectAppUser } = await import("@/integrations/lovable/appUserConnector");
        await disconnectAppUser({
          gatewayBaseUrl: GATEWAY_BASE_URL,
          connectionAPIKey: conn.connectionAPIKey,
          connectorId: CONNECTOR_ID,
        });
      } catch (e) {
        console.error("[disconnectGoogleDrive] gateway disconnect failed:", e);
      }
    }
    await deleteConnectionForUser(context.userId, CONNECTOR_ID);
    return { ok: true as const };
  });

// ---- Helper: find or create the named folder on Drive ----
// The `drive.file` scope only lets `files.list` see folders this app itself
// created (or the user opened via a picker), so this can only ever reuse a
// folder from a prior run of this function, never one the manager made by
// hand in Drive with the same name. That's an accepted limitation of the
// scope, not a bug: broadening to `drive` or `drive.readonly` would let
// discovery work generally, but only at the cost of consent for the whole
// Drive instead of just this app's files.
async function ensureFolder(connectionAPIKey: string, folderName: string): Promise<string> {
  const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
  const escapedName = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `name='${escapedName}' and mimeType='${FOLDER_MIME_TYPE}' and trashed=false`,
  );
  // Deliberately the default (`user`) corpus, not `allDrives`: this is the
  // typed-a-name path, and it creates in the manager's own Drive below. Search
  // every shared drive too and which of two same-named folders wins would come
  // down to whatever Drive happened to return first for `pageSize=1`.
  const search = await callAsAppUser({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    connectionAPIKey,
    connectorId: CONNECTOR_ID,
    path: `/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1&supportsAllDrives=true`,
  });
  if (!search.ok) throw new Error(`Drive folder search failed: ${await search.text()}`);
  const found = (await search.json()) as { files?: { id: string }[] };
  if (found.files && found.files[0]) return found.files[0].id;

  const create = await callAsAppUser({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    connectionAPIKey,
    connectorId: CONNECTOR_ID,
    path: "/drive/v3/files?fields=id",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: folderName,
        mimeType: FOLDER_MIME_TYPE,
      }),
    },
  });
  if (!create.ok) throw new Error(`Drive folder create failed: ${await create.text()}`);
  const created = (await create.json()) as { id: string };
  return created.id;
}

/** Carries Drive's HTTP status so the caller can tell "folder is gone" from "Drive had a bad day". */
export class DriveUploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DriveUploadError";
    this.status = status;
  }
}

/**
 * Whether a failed upload justifies re-resolving the configured folder NAME
 * (which creates the folder if the search misses).
 *
 * This is deliberately narrow, because getting it wrong is invisible and
 * expensive: recreating on any failure means one bad response can mint a fresh
 * "UTS Jitsu Waivers" folder in the manager's My Drive and quietly redirect
 * every future waiver into it, while the folder they actually chose (possibly
 * in a shared drive the whole committee watches) stops receiving anything.
 *
 * So: only a 404, and only when the folder came from a typed name. A 403 is a
 * permission problem on a folder that still exists, a 5xx is Drive's problem,
 * and a picked folder cannot be recreated by name at all — its name is not
 * where it lives. Those all surface to the manager instead.
 *
 * Connections saved before `folderSource` existed are treated as name-based,
 * which is what they were: the picker path did not exist yet.
 */
export function shouldRecreateFolder(params: {
  status: number | null;
  folderSource: string | null | undefined;
}): boolean {
  return params.status === 404 && params.folderSource !== "picker";
}

async function uploadPdfToDrive(params: {
  connectionAPIKey: string;
  folderId: string;
  name: string;
  pdf: Uint8Array;
}): Promise<{ id: string; webViewLink: string | null }> {
  const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
  const boundary = `----utsjitsu${Date.now()}`;
  const metadata = { name: params.name, parents: [params.folderId], mimeType: "application/pdf" };
  const enc = new TextEncoder();
  const pre = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  const post = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(pre.length + params.pdf.length + post.length);
  body.set(pre, 0);
  body.set(params.pdf, pre.length);
  body.set(post, pre.length + params.pdf.length);

  const res = await callAsAppUser({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    connectionAPIKey: params.connectionAPIKey,
    connectorId: CONNECTOR_ID,
    // `supportsAllDrives` lets the parent folder be one in a shared drive.
    path: "/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true",
    init: {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  });
  if (!res.ok) {
    throw new DriveUploadError(
      res.status,
      `Drive upload failed (${res.status}): ${await res.text()}`,
    );
  }
  const out = (await res.json()) as { id: string; webViewLink?: string };
  return { id: out.id, webViewLink: out.webViewLink ?? null };
}

// ---- Upload a waiver PDF to the manager's Drive ----
export const uploadWaiverToDrive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ waiverId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getConnectionForUser, updateConnectionMetadata } =
      await import("./app-user-connections.server");

    const conn = await getConnectionForUser(context.userId, CONNECTOR_ID);
    if (!conn) throw new Error("Connect your Google account first.");

    const admin = supabaseAdmin;
    // The Drive filename uses the SUBMITTED name on the waiver row (the frozen
    // submission the PDF was generated from), not the live profile.
    const { data: waiver, error: wErr } = await admin
      .from("waivers")
      .select("id, signed_at, pdf_path, first_name, middle_name, last_name")
      .eq("id", data.waiverId)
      .maybeSingle();
    if (wErr) throw new Error(wErr.message);
    if (!waiver?.pdf_path) throw new Error("Waiver PDF not found.");

    const { data: pdfBlob, error: dlErr } = await supabaseAdmin.storage
      .from("waivers")
      .download(waiver.pdf_path);
    if (dlErr || !pdfBlob)
      throw new Error(dlErr?.message ?? "Could not download the PDF. Try again.");
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    let folderId = conn.metadata.folderId as string | undefined;
    const folderName = conn.metadata.folderName as string | undefined;
    if (!folderId || !folderName) {
      throw new Error("Set up a Drive folder on your account page before saving waivers.");
    }

    const signedDate = new Date(waiver.signed_at).toISOString().slice(0, 10);
    const fullName = profileFullName(waiver);
    const safeName = fullName.replace(/[^a-z0-9\-_ ]/gi, "").trim() || "waiver";
    const name = `${signedDate} - ${safeName}.pdf`;

    let uploaded;
    try {
      uploaded = await uploadPdfToDrive({
        connectionAPIKey: conn.connectionAPIKey,
        folderId,
        name,
        pdf: pdfBytes,
      });
    } catch (e) {
      const status = e instanceof DriveUploadError ? e.status : null;
      const folderSource = conn.metadata.folderSource as string | undefined;
      if (!shouldRecreateFolder({ status, folderSource })) {
        console.error("[uploadWaiverToDrive] upload failed, not re-resolving the folder:", e);
        if (status === 404) {
          // A picked folder that Drive can no longer find. Recreating it by
          // name would put waivers somewhere the manager never chose, so ask
          // them to pick again instead.
          throw new Error(
            `The Drive folder "${folderName}" is no longer reachable. Pick it again on your account page.`,
          );
        }
        throw e;
      }
      // The folder was resolved from a typed name and Drive says it's gone:
      // re-resolve that name (creating it if need be) and retry once.
      folderId = await ensureFolder(conn.connectionAPIKey, folderName);
      await updateConnectionMetadata(context.userId, CONNECTOR_ID, {
        ...conn.metadata,
        folderId,
      });
      uploaded = await uploadPdfToDrive({
        connectionAPIKey: conn.connectionAPIKey,
        folderId,
        name,
        pdf: pdfBytes,
      });
      console.error("[uploadWaiverToDrive] folder was missing, recreated and retried:", e);
    }

    const uploadedAt = new Date().toISOString();
    await supabaseAdmin.from("waiver_drive_uploads").upsert(
      {
        waiver_id: waiver.id,
        manager_user_id: context.userId,
        drive_file_id: uploaded.id,
        drive_web_view_link: uploaded.webViewLink,
        uploaded_at: uploadedAt,
      },
      { onConflict: "waiver_id,manager_user_id" },
    );

    return {
      ok: true as const,
      driveFileId: uploaded.id,
      webViewLink: uploaded.webViewLink,
    };
  });

// ---- List which of my (manager) waiver Drive uploads exist ----
export const listMyDriveUploads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("waiver_drive_uploads")
      .select("waiver_id, drive_file_id, drive_web_view_link, uploaded_at")
      .eq("manager_user_id", context.userId);
    if (error) throw new Error(error.message);
    return (data ?? []) as {
      waiver_id: string;
      drive_file_id: string | null;
      drive_web_view_link: string | null;
      uploaded_at: string | null;
    }[];
  });
