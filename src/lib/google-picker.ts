/**
 * Google Picker folder selection — client-only, no server imports.
 * Loads Google Identity Services + the Picker API on demand and lets the
 * manager visually pick a Drive folder under the same OAuth client the
 * server-side Drive connector uses: `drive.file` grants are recorded per
 * (user, OAuth client, file), not per token, so whatever they pick here
 * becomes reachable by the server-side upload too.
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

interface GooglePickerBuilder {
  addView: (view: GooglePickerView) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
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
            callback: (resp: { access_token?: string; error?: string }) => void;
          }): { requestAccessToken: (opts?: { prompt?: string }) => void };
          revoke(token: string, done: () => void): void;
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

// Every way Google's own scripts can fail to arrive reads the same to the
// manager: the button did nothing. The URL that failed is the useful part for
// us and means nothing to them, so it goes to the console and the toast gets
// the sentence with a way out.
const LOAD_FAILED = "Could not load Google's folder picker. Check your connection and try again.";

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
    script.onerror = () => {
      console.warn(`[google-picker] script did not load: ${src}`);
      reject(new Error(LOAD_FAILED));
    };
    document.head.appendChild(script);
  });
}

async function loadPickerLibrary(): Promise<void> {
  await loadScript(GAPI_SRC);
  if (!window.gapi) throw new Error(LOAD_FAILED);
  await new Promise<void>((resolve) => window.gapi!.load("picker", () => resolve()));
}

async function requestAccessToken(clientId: string): Promise<string> {
  await loadScript(GIS_SRC);
  if (!window.google) throw new Error(LOAD_FAILED);
  const google = window.google;
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
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
 * Opens Google Picker restricted to folder selection. Resolves with the
 * picked folder, or null if the manager closed the picker without choosing one.
 */
export async function pickDriveFolder(clientId: string): Promise<PickedDriveFolder | null> {
  const [, token] = await Promise.all([loadPickerLibrary(), requestAccessToken(clientId)]);
  const google = window.google;
  if (!google) throw new Error(LOAD_FAILED);

  return new Promise((resolve, reject) => {
    try {
      // The token is scoped to this one picker session and used nowhere else,
      // so once the manager has picked (or cancelled) there's no reason for it
      // to remain valid — revoke it rather than leave it live until Google's
      // own expiry.
      const finish = (result: PickedDriveFolder | null) => {
        google.accounts.oauth2.revoke(token, () => {});
        resolve(result);
      };

      const builder = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        // Restricts the picker's postMessage response channel to this page's
        // own origin, per Google's Picker integration guidance.
        .setOrigin(window.location.origin)
        .setTitle("Choose a folder for signed waivers");

      const appId = appIdFromClientId(clientId);
      if (appId) builder.setAppId(appId);

      for (const view of buildFolderViews(google.picker)) builder.addView(view);

      const picker = builder
        .setCallback((data: PickerResponse) => {
          const result = readPickerResponse(google.picker, data);
          if (result.status === "picked") finish(result.folder);
          else if (result.status === "cancelled") finish(null);
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      reject(e instanceof Error ? e : new Error("Could not open the folder picker. Try again."));
    }
  });
}
