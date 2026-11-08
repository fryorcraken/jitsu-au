# Google Drive: native connector vs what we built (answers, no code changes)

Checked this turn: the workspace already has one native Google Drive connection, "Sensei's Google Drive". I read its settings and made one read-only test call against it, which listed the shared drives it can see. It returned three shared drives. Nothing was linked or changed.

## Answers

1. **The difference.** The app-user connector is bring-your-own: the club's OAuth client, and every manager connects inside the app. The native connector is a single connection that someone authorizes from Lovable's connector settings, and the app's server code uses it. Who owns its OAuth app: the existing connection was made without the club's Google Cloud client, and the Lovable connector setup did not ask for a client id or secret. So it runs on Lovable's managed client. I can't see the client id myself, so that part is inferred from how it was set up, not read.
2. **One connection per project, not per end user.** It is a single account (here, sensei's) shared by all server calls. Managers would not connect anything on /account.
3. **Scopes. This is the deciding fact.** The connection currently holds `drive.file`, `drive.appdata` and **`drive.readonly`**. Full `drive` and `drive.metadata` can be added on reconnect. The test call proved `drives.list` works today. So a server-drawn folder browser (shared drives included) works with no Picker, no API key and no Google Cloud work. **The catch:** `drive.readonly` can list folders but cannot write into them. `drive.file` only lets us write into folders this client created or was granted. So to upload waivers into an existing folder someone picked, the connection needs the full **`drive`** scope, added by reconnecting in connector settings. That gives access to sensei's whole Drive, not just waiver files.
4. **Yes, your assumption is right.** `drive.file` grants are tied to the OAuth client. A pick made through the club's client would mean nothing to a connection on Lovable's client. With full `drive` that stops mattering.
5. **Switching.** The two systems are stored separately. Existing manager connections keep working until we remove them. The stored folder ID is a real Drive ID, so the native connection can reuse it as is (with full `drive`, provided sensei's account can reach that folder). Nobody signing a waiver would notice. Upload is already a background step after the PDF is saved, so the worst case during the switch is a waiver that isn't copied to Drive, not a failed signature. Managers would not reconnect anything. One person reconnects the native connection once, to add `drive`.
6. **Recommendation: move to the native connection with full `drive`, and build our own folder browser.** For one or two managers saving club records, a single shared account fits better. It removes the Picker, the API key, the Picker API, the club's OAuth client and the per-manager connect step. Trade-offs to accept: every upload is made as sensei's account, and the app can reach everything in that Drive. If that access is too broad, stay on the current design.

## If you approve the switch (later, separate change)

- Sensei reconnects the native Drive connection and adds the full `drive` scope. I link it to the project.
- Managers get a folder browser on /account: shared drives and folders, drawn by us. They pick one, and waivers land there.
- Remove the Google sign-in-per-manager card, the Picker and its key, and the stored manager connections. Docs updated to match.
- Waiver signing is unchanged for members.

## Technical notes

- Connection: gateway-backed `google_drive`, `data_scope: individual`, currently not linked to the project.
- Uploads: `POST /upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true` with the stored parent ID. Listing: `files.list` with `includeItemsFromAllDrives`, `supportsAllDrives`, `q="mimeType='application/vnd.google-apps.folder'"`, plus `drives.list`.
- Unverified: the OAuth client's identity, and whether Lovable's app is Google-verified for the restricted `drive` scope. Reconnecting will show the actual consent screen.
