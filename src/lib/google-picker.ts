/**
 * Google Picker folder selection — client-only, no server imports.
 * Loads Google Identity Services + the Picker API on demand and lets the
 * manager visually pick a Drive folder under the same OAuth client the
 * server-side Drive connector uses: `drive.file` grants are recorded per
 * (user, OAuth client, file), not per token, so whatever they pick here
 * becomes reachable by the server-side upload too.
 */

export interface PickedDriveFolder {
  id: string;
  name: string;
}

type PickerResponse = Record<string, unknown>;

interface GooglePickerView {
  setSelectFolderEnabled: (enabled: boolean) => GooglePickerView;
  setIncludeFolders: (include: boolean) => GooglePickerView;
}

interface GooglePickerBuilder {
  addView: (view: GooglePickerView) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setOrigin: (origin: string) => GooglePickerBuilder;
  setCallback: (cb: (data: PickerResponse) => void) => GooglePickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
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
      picker: {
        ViewId: { FOLDERS: string };
        DocsView: new (viewId: string) => GooglePickerView;
        PickerBuilder: new () => GooglePickerBuilder;
        Action: { PICKED: string; CANCEL: string };
        Response: { ACTION: string; DOCUMENTS: string };
        Document: { ID: string; NAME: string };
      };
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

async function requestAccessToken(clientId: string): Promise<string> {
  await loadScript(GIS_SRC);
  if (!window.google) throw new Error("Google Identity Services did not load");
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
 * Opens Google Picker restricted to folder selection. Resolves with the
 * picked folder, or null if the manager closed the picker without choosing one.
 */
export async function pickDriveFolder(clientId: string): Promise<PickedDriveFolder | null> {
  const [, token] = await Promise.all([loadPickerLibrary(), requestAccessToken(clientId)]);
  const google = window.google;
  if (!google) throw new Error("Google Identity Services did not load");

  return new Promise((resolve, reject) => {
    try {
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true);

      // The token is scoped to this one picker session and used nowhere else,
      // so once the manager has picked (or cancelled) there's no reason for it
      // to remain valid — revoke it rather than leave it live until Google's
      // own expiry.
      const finish = (result: PickedDriveFolder | null) => {
        google.accounts.oauth2.revoke(token, () => {});
        resolve(result);
      };

      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        // Restricts the picker's postMessage response channel to this page's
        // own origin, per Google's Picker integration guidance.
        .setOrigin(window.location.origin)
        .setCallback((data: PickerResponse) => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {
            const docs = data[google.picker.Response.DOCUMENTS] as
              | Record<string, unknown>[]
              | undefined;
            const doc = docs?.[0];
            if (!doc) {
              finish(null);
              return;
            }
            finish({
              id: String(doc[google.picker.Document.ID]),
              name: String(doc[google.picker.Document.NAME]),
            });
          } else if (action === google.picker.Action.CANCEL) {
            finish(null);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      reject(e instanceof Error ? e : new Error("Failed to open Google Picker"));
    }
  });
}
