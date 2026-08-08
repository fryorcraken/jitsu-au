/**
 * Google Picker folder selection — client-only, no server imports.
 * Loads Google Identity Services + the Picker API on demand and lets the
 * manager visually pick a Drive folder under the same OAuth client the
 * server-side Drive connector uses: `drive.file` grants are recorded per
 * (user, OAuth client, file), not per token, so whatever they pick here
 * becomes reachable by the server-side upload too.
 *
 * That "per (user, OAuth client, file)" is the whole reason this file is
 * fussy about identity. Everything Google checks when the manager presses
 * Select is checked silently: a missing API key, an app id from another
 * project, or a browser signed into a different Google account all end the
 * same way, with a greyed-out Select button and no callback. So the picker is
 * only offered when both halves of the project are configured
 * (`VITE_GOOGLE_OAUTH_CLIENT_ID` and `VITE_GOOGLE_PICKER_API_KEY`, with the
 * Picker API enabled on that project), and the account is checked up front.
 */

import { FOLDER_MIME_TYPE } from "./google-drive.constants";

export interface PickedDriveFolder {
  id: string;
  name: string;
}

export type PickerResponse = Record<string, unknown>;

export interface GooglePickerView {
  setSelectFolderEnabled: (enabled: boolean) => GooglePickerView;
  setIncludeFolders: (include: boolean) => GooglePickerView;
  setMimeTypes: (mimeTypes: string) => GooglePickerView;
  setMode: (mode: string) => GooglePickerView;
  setParent: (parentId: string) => GooglePickerView;
  setEnableDrives: (enabled: boolean) => GooglePickerView;
  setOwnedByMe: (ownedByMe: boolean) => GooglePickerView;
  setLabel: (label: string) => GooglePickerView;
}

export interface GooglePickerBuilder {
  addView: (view: GooglePickerView) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setOrigin: (origin: string) => GooglePickerBuilder;
  setTitle: (title: string) => GooglePickerBuilder;
  setAppId: (appId: string) => GooglePickerBuilder;
  setCallback: (cb: (data: PickerResponse) => void) => GooglePickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
}

export interface GooglePickerNamespace {
  ViewId: { FOLDERS: string };
  DocsViewMode: { LIST: string; GRID: string };
  DocsView: new (viewId: string) => GooglePickerView;
  PickerBuilder: new () => GooglePickerBuilder;
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string };
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            hint?: string;
            callback: (resp: { access_token?: string; error?: string }) => void;
          }): { requestAccessToken: (opts?: { prompt?: string }) => void };
        };
      };
      picker: GooglePickerNamespace;
    };
    gapi?: {
      load: (api: string, callback: () => void) => void;
    };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadPickerLibrary(): Promise<void> {
  await loadScript(GAPI_SRC);
  if (!window.gapi) throw new Error("Google API script did not load");
  await new Promise<void>((resolve) => window.gapi!.load("picker", () => resolve()));
}

/**
 * `hint` is the connected Google account's address. Without it the token popup
 * silently uses whichever account the browser happens to have as its default,
 * and a manager signed into two accounts then picks a folder their *connection*
 * cannot see: `drive.file` access is recorded against (Google account, OAuth
 * client, file), so the pick looks fine and the server's read-back 404s.
 */
async function requestAccessToken(clientId: string, loginHint?: string): Promise<string> {
  await loadScript(GIS_SRC);
  if (!window.google) throw new Error("Google Identity Services did not load");
  const google = window.google;
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      ...(loginHint ? { hint: loginHint } : {}),
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error ?? "Google sign-in was cancelled"));
          return;
        }
        resolve(resp.access_token);
      },
    });
    client.requestAccessToken();
  });
}

/**
 * The account the picker token belongs to, or null if Drive would not say.
 * `about.get` is readable under `drive.file`, and it is the only way to learn
 * which account the popup actually signed in as: the token itself carries no
 * address, and the `userinfo` endpoints need scopes this token does not have.
 */
async function tokenAccountEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { emailAddress?: string } };
    return body.user?.emailAddress ?? null;
  } catch {
    // A blocked or flaky request is not a reason to stop the manager picking.
    return null;
  }
}

/**
 * The message for "you are picking as the wrong Google account", or null when
 * there is nothing to complain about. A pick made under the wrong account fails
 * later, on the server, as an unreadable folder id, so it is worth catching
 * here where we can still name both accounts.
 */
export function accountMismatchMessage(
  pickerEmail: string | null,
  connectedEmail: string | null | undefined,
): string | null {
  if (!pickerEmail || !connectedEmail) return null;
  if (pickerEmail.trim().toLowerCase() === connectedEmail.trim().toLowerCase()) return null;
  return `Google signed you in as ${pickerEmail}, but this site's Drive is connected as ${connectedEmail}. Sign in as ${connectedEmail} and try again, or reconnect Google Drive with ${pickerEmail}.`;
}

/**
 * An OAuth client id looks like `<project-number>-<hash>.apps.googleusercontent.com`,
 * and Picker's `setAppId` wants that leading project number. Google requires it
 * for `drive.file`: without it the picker can show items but cannot record the
 * per-file grant that makes the pick reachable by the app afterwards.
 */
export function appIdFromClientId(clientId: string): string | null {
  const projectNumber = clientId.split("-")[0];
  return /^\d+$/.test(projectNumber) ? projectNumber : null;
}

/**
 * The three places a manager's waiver folder can live, each as its own tab.
 *
 * Folders-only comes from the view itself: `DocsView(FOLDERS)` plus a folder
 * mime filter means a file is never listed, so it can never be handed back.
 * Deliberately NOT `PickerBuilder.setSelectableMimeTypes`: Google documents
 * that as the filter on selectable *files* and says nothing about how it
 * interacts with `setSelectFolderEnabled`, so if it excluded folders the
 * Select button would be dead for everything. Listing no files is the same
 * guarantee with no way to lock the manager out, and `resolvePickedFolder`
 * rejects a non-folder id server-side regardless.
 *
 * "My Drive" starts at `root` rather than the default flat listing of every
 * folder in the account, so it browses as a tree the way Drive itself does.
 * "Shared drives" is the only view that can reach a team/shared drive, and it
 * omits the mime filter on purpose: the top level of that view lists the
 * drives themselves, which aren't folder-mimetyped, and filtering them out
 * would leave the tab empty with nothing to navigate into. "Shared with me"
 * covers a folder someone else owns and shared directly.
 *
 * Google documents `setEnableDrives` as incompatible with both `setParent`
 * and `setOwnedByMe` (the combination returns nothing), which is why these
 * are three separate views rather than one combined one.
 *
 * List mode, not the default thumbnail grid: under `drive.file` the app has no
 * access to thumbnails, so the grid renders as rows of blanks.
 */
export function buildFolderViews(picker: GooglePickerNamespace): GooglePickerView[] {
  const folderView = () =>
    new picker.DocsView(picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMode(picker.DocsViewMode.LIST);

  // `setLabel` is marked deprecated in Google's own typings but is still what
  // names the tabs; if a future picker drops it, the fallback is the picker's
  // own per-view default names, not a broken dialog.
  return [
    folderView().setMimeTypes(FOLDER_MIME_TYPE).setParent("root").setLabel("My Drive"),
    folderView().setEnableDrives(true).setLabel("Shared drives"),
    folderView().setMimeTypes(FOLDER_MIME_TYPE).setOwnedByMe(false).setLabel("Shared with me"),
  ];
}

/**
 * Reads one picker callback payload. Split out from `pickDriveFolder` because
 * it is the only part of the callback with a decision in it, and the only part
 * a test can reach without Google's globals: the picker fires this for
 * intermediate states too, which must not be mistaken for a cancellation.
 */
export function readPickerResponse(
  picker: GooglePickerNamespace,
  data: PickerResponse,
): { status: "picked"; folder: PickedDriveFolder | null } | { status: "cancelled" | "pending" } {
  const action = data[picker.Response.ACTION];
  if (action === picker.Action.CANCEL) return { status: "cancelled" };
  if (action !== picker.Action.PICKED) return { status: "pending" };

  const docs = data[picker.Response.DOCUMENTS] as Record<string, unknown>[] | undefined;
  const doc = docs?.[0];
  if (!doc) return { status: "picked", folder: null };
  return {
    status: "picked",
    folder: {
      id: String(doc[picker.Document.ID]),
      name: String(doc[picker.Document.NAME]),
    },
  };
}

/**
 * Assembles the picker. Split from `pickDriveFolder` so the builder wiring can
 * be pinned by a test: everything Google enforces when the manager presses
 * Select lives here, and getting any of it wrong fails the same silent way.
 *
 * `setDeveloperKey` is not optional decoration. Google enforces the API key
 * together with the app id on the response path, so a picker built without one
 * browses perfectly and then swallows the Select: the button greys out, no
 * callback ever fires, and the dialog just sits there. The key must come from
 * the same Cloud project as the OAuth client, with the Picker API enabled on
 * it (the Picker API is separate from the Drive API, and a disabled one fails
 * identically).
 */
export function buildFolderPicker(
  picker: GooglePickerNamespace,
  opts: {
    token: string;
    developerKey: string;
    appId: string | null;
    origin: string;
    onResponse: (data: PickerResponse) => void;
  },
): { setVisible: (visible: boolean) => void } {
  const builder = new picker.PickerBuilder()
    .setOAuthToken(opts.token)
    .setDeveloperKey(opts.developerKey)
    // Restricts the picker's postMessage response channel to this page's
    // own origin, per Google's Picker integration guidance.
    .setOrigin(opts.origin)
    .setTitle("Choose a folder for signed waivers");

  if (opts.appId) builder.setAppId(opts.appId);
  for (const view of buildFolderViews(picker)) builder.addView(view);

  return builder.setCallback(opts.onResponse).build();
}

export interface PickDriveFolderOptions {
  /** OAuth client id, which must be the one the server-side connector runs on. */
  clientId: string;
  /** Browser API key from the same Cloud project, with the Picker API enabled. */
  developerKey: string;
  /** The Google account this site's Drive is connected as, when we know it. */
  connectedEmail?: string | null;
}

/**
 * Opens Google Picker restricted to folder selection. Resolves with the
 * picked folder, or null if the manager closed the picker without choosing one.
 */
export async function pickDriveFolder(
  opts: PickDriveFolderOptions,
): Promise<PickedDriveFolder | null> {
  const [, token] = await Promise.all([
    loadPickerLibrary(),
    requestAccessToken(opts.clientId, opts.connectedEmail ?? undefined),
  ]);
  const google = window.google;
  if (!google) throw new Error("Google Identity Services did not load");

  const mismatch = accountMismatchMessage(await tokenAccountEmail(token), opts.connectedEmail);
  if (mismatch) throw new Error(mismatch);

  return new Promise((resolve, reject) => {
    try {
      // Deliberately no `oauth2.revoke` when we're done. Revoking an access
      // token revokes the whole grant for this (account, OAuth client) pair:
      // it would tear up the per-file access the pick just recorded, and the
      // connector's own refresh token with it, disconnecting Drive entirely.
      // The token is short-lived and Google expires it on its own.
      const picker = buildFolderPicker(google.picker, {
        token,
        developerKey: opts.developerKey,
        appId: appIdFromClientId(opts.clientId),
        origin: window.location.origin,
        onResponse: (data) => {
          const result = readPickerResponse(google.picker, data);
          if (result.status === "picked") resolve(result.folder);
          else if (result.status === "cancelled") resolve(null);
        },
      });
      picker.setVisible(true);
    } catch (e) {
      reject(e instanceof Error ? e : new Error("Failed to open Google Picker"));
    }
  });
}
