# Google Drive integration for managers

Let a manager connect their personal Google account so signed waiver PDFs are copied into a folder in **their** Google Drive, in addition to being stored in Lovable Cloud storage (nothing changes for members signing waivers).

This uses Lovable's **App User Connector** for `google_drive` — each manager does their own OAuth consent; we never store Google credentials in code, and the connection is scoped to the signed-in manager.

## User-facing behavior

- On `/account` (for managers only), add a **Google Drive** card:
  - If not connected: "Connect Google Drive" button + short explainer. Clicking opens the Google consent popup.
  - If connected: shows the connected Google email, a "Disconnect" button, and an editable **Drive folder name** (default `UTS Jitsu Waivers`) where PDFs will be saved.
- On `/manager/waivers`, add a per-row **Save to Drive** button (and a "Save all missing" bulk action) for managers whose Drive is connected. Rows show a small badge once uploaded.
- New waivers submitted via `/waiver` automatically upload to the Drive of every connected manager, in the background — signing never blocks on Drive.
- The member-facing waiver flow is unchanged.

## Setup steps (one-time, done by you in chat)

1. Run `connector_app_user--connect_client` for `google_drive`. You'll get a form to create/select a Google OAuth web client and confirm the redirect URI `https://connector-gateway.lovable.dev/api/v1/app-users/oauth2/callback`. This syncs `GOOGLE_DRIVE_APP_USER_CONNECTOR_CLIENT_API_KEY` into the project.
2. Confirm the client has **offline access** enabled (required to store a reusable connection key). If not, a workspace admin toggles it.

## Technical section

### New/updated files

- `src/integrations/lovable/appUserConnector.ts` — server-only gateway helpers (`authorizeAppUserOAuth`, `callAsAppUser`, `disconnectAppUser`, `exchangeAppUserOAuthCode`) — verbatim from the Lovable knowledge card.
- `src/integrations/lovable/appUserConnectorClient.ts` — browser-safe popup helper (`connectAppUser`) — verbatim.
- `src/lib/connection-key-crypto.server.ts` — AES-256-GCM encrypt/decrypt using `APP_USER_CONNECTION_KEY_SECRET` (auto-provisioned by Lovable).
- `src/lib/app-user-connections.server.ts` — `saveConnectionKeyForUser` / `getConnectionKeyForUser` / `deleteConnectionKeyForUser` reading `public.app_user_connections` via `supabaseAdmin`.
- `src/lib/google-drive.functions.ts` — server functions, all `.middleware([requireSupabaseAuth])` and manager-gated via `has_role`:
  - `startGoogleDriveConnect(targetOrigin)` → returns `authorizationUrl` (popup, `response_mode: "web_message"`, scopes: `userinfo.email`, `userinfo.profile`, `drive.file`).
  - `saveGoogleDriveConnection({ connectionAPIKey })` → encrypt + upsert; also fetches `/oauth2/v2/userinfo` to cache the connected email.
  - `getGoogleDriveStatus()` → `{ connected, email, folderName }`.
  - `setDriveFolderName({ folderName })`.
  - `disconnectGoogleDrive()` → gateway `disconnectAppUser` + row delete.
  - `uploadWaiverToDrive({ waiverId })` — downloads the PDF from the `waivers` bucket via `supabaseAdmin`, ensures the target folder exists (search by name in `drive.file` scope, create if missing, cache folder id), and does a multipart upload via `callAsAppUser` to `/upload/drive/v3/files?uploadType=multipart`. Records success in `waiver_drive_uploads`.
- `src/routes/_authenticated/account.tsx` — manager-only "Google Drive" card (connect / disconnect / folder name).
- `src/routes/_authenticated/manager.waivers.tsx` — add "Save to Drive" per row + "Save all missing"; show badge.
- `src/lib/waiver.functions.ts` — after successful waiver insert + PDF upload, enqueue Drive uploads for every connected manager (fire-and-forget; failures logged, don't affect the response).

### DB migration

```sql
create table public.app_user_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  connector_id text not null,
  connection_key_ciphertext text not null,
  connected_email text,
  metadata jsonb not null default '{}'::jsonb,   -- e.g. { folder_name, folder_id }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, connector_id)
);
grant select, insert, update, delete on public.app_user_connections to service_role;
alter table public.app_user_connections enable row level security;

create table public.waiver_drive_uploads (
  id uuid primary key default gen_random_uuid(),
  waiver_id uuid not null references public.waivers(id) on delete cascade,
  manager_user_id uuid not null,
  drive_file_id text not null,
  drive_web_view_link text,
  uploaded_at timestamptz not null default now(),
  unique (waiver_id, manager_user_id)
);
grant select, insert, update, delete on public.waiver_drive_uploads to service_role;
alter table public.waiver_drive_uploads enable row level security;
```

No `anon`/`authenticated` grants — all access is via `supabaseAdmin` inside server functions that verify manager role.

### Security notes

- Connection keys (`lovack_*`) are encrypted at rest with `APP_USER_CONNECTION_KEY_SECRET`, keyed by `(user_id, connector_id)`.
- Only `google_drive` scope requested is `drive.file` — the app can only see/modify files it created, not the manager's whole Drive.
- All provider calls happen server-side; no Google tokens or connection keys reach the browser.
- Both server functions and the UI gate on `has_role(auth.uid(), 'manager')`.

### Out of scope (ask if you want it)

- Sharing the Drive folder with other managers.
- Backfilling existing waivers on first connect (only new signs auto-upload; managers can bulk-upload from `/manager/waivers`).
- Google Docs/Sheets index of waivers.
