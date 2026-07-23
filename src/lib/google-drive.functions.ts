import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { profileFullName } from "@/lib/validation";
import type { AppClient } from "@/lib/profile-types";

const GATEWAY_BASE_URL = "https://connector-gateway.lovable.dev";
const CONNECTOR_ID = "google_drive";
const FOLDER_NAME = "UTS Jitsu Waivers";
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

// ---- Status: is Google Drive connected? ----
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
    };
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

// ---- Helper: find or create the target folder on Drive ----
async function ensureFolder(connectionAPIKey: string): Promise<string> {
  const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const search = await callAsAppUser({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    connectionAPIKey,
    connectorId: CONNECTOR_ID,
    path: `/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`,
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
        name: FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    },
  });
  if (!create.ok) throw new Error(`Drive folder create failed: ${await create.text()}`);
  const created = (await create.json()) as { id: string };
  return created.id;
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
    path: "/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    init: {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  });
  if (!res.ok) throw new Error(`Drive upload failed (${res.status}): ${await res.text()}`);
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

    const admin = supabaseAdmin as unknown as AppClient;
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
    if (dlErr || !pdfBlob) throw new Error(dlErr?.message ?? "Failed to download PDF.");
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    let folderId =
      (conn.metadata.folderId as string | undefined) ?? (await ensureFolder(conn.connectionAPIKey));
    if (!conn.metadata.folderId) {
      await updateConnectionMetadata(context.userId, CONNECTOR_ID, {
        ...conn.metadata,
        folderId,
      });
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
      // Folder may have been deleted; retry once with a fresh folder.
      folderId = await ensureFolder(conn.connectionAPIKey);
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
      console.error("[uploadWaiverToDrive] first attempt failed, retried:", e);
    }

    const uploadedAt = new Date().toISOString();
    await supabaseAdmin.from("waiver_drive_uploads").upsert(
      {
        waiver_id: waiver.id,
        manager_user_id: context.userId,
        drive_file_id: uploaded.id,
        drive_web_view_link: uploaded.webViewLink,
        uploaded_at: uploadedAt,
      } as never,
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
