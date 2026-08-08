// The picker's *configuration* is the whole product behaviour here: get it
// wrong and the manager is asked to select a file, can only see the folders in
// their own My Drive, or (the bug this file grew for) presses Select and
// watches nothing happen. Everything Google enforces on the pick is enforced
// silently, so each piece of it is pinned here: the views the picker opens
// with, the key/app id/token the response path depends on, and the account
// check that stops a pick the server would never be able to read.
// `pickDriveFolder` runs against stand-ins for Google's globals.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLDER_MIME_TYPE } from "./google-drive.constants";
import {
  accountMismatchMessage,
  appIdFromClientId,
  buildFolderPicker,
  buildFolderViews,
  type GooglePickerBuilder,
  type GooglePickerNamespace,
  type GooglePickerView,
  type PickerResponse,
  pickDriveFolder,
  readPickerResponse,
} from "./google-picker";

type Recorded = Record<string, unknown>;

/** What the fake builder recorded, so a test can inspect the picker we built. */
interface BuiltPicker {
  calls: Recorded;
  addedViews: number;
  visible: boolean;
  respond: (data: PickerResponse) => void;
}

function fakePicker(): { picker: GooglePickerNamespace; views: Recorded[]; built: BuiltPicker } {
  const views: Recorded[] = [];
  const built: BuiltPicker = {
    calls: {},
    addedViews: 0,
    visible: false,
    respond: () => {},
  };

  class FakeDocsView implements GooglePickerView {
    private readonly calls: Recorded;
    constructor(viewId: string) {
      this.calls = { viewId };
      views.push(this.calls);
    }
    private set(key: string, value: unknown) {
      this.calls[key] = value;
      return this;
    }
    setSelectFolderEnabled(v: boolean) {
      return this.set("selectFolderEnabled", v);
    }
    setIncludeFolders(v: boolean) {
      return this.set("includeFolders", v);
    }
    setMimeTypes(v: string) {
      return this.set("mimeTypes", v);
    }
    setMode(v: string) {
      return this.set("mode", v);
    }
    setParent(v: string) {
      return this.set("parent", v);
    }
    setEnableDrives(v: boolean) {
      return this.set("enableDrives", v);
    }
    setOwnedByMe(v: boolean) {
      return this.set("ownedByMe", v);
    }
    setLabel(v: string) {
      return this.set("label", v);
    }
  }

  class FakePickerBuilder implements GooglePickerBuilder {
    private set(key: string, value: unknown) {
      built.calls[key] = value;
      return this;
    }
    addView(view: GooglePickerView) {
      built.addedViews += 1;
      void view;
      return this;
    }
    setOAuthToken(v: string) {
      return this.set("oauthToken", v);
    }
    setDeveloperKey(v: string) {
      return this.set("developerKey", v);
    }
    setOrigin(v: string) {
      return this.set("origin", v);
    }
    setTitle(v: string) {
      return this.set("title", v);
    }
    setAppId(v: string) {
      return this.set("appId", v);
    }
    setCallback(cb: (data: PickerResponse) => void) {
      built.respond = cb;
      return this;
    }
    build() {
      return {
        setVisible: (visible: boolean) => {
          built.visible = visible;
        },
      };
    }
  }

  return {
    views,
    built,
    picker: {
      ViewId: { FOLDERS: "folders" },
      DocsViewMode: { LIST: "list", GRID: "grid" },
      DocsView: FakeDocsView,
      PickerBuilder: FakePickerBuilder,
      Action: { PICKED: "picked", CANCEL: "cancel" },
      Response: { ACTION: "action", DOCUMENTS: "docs" },
      Document: { ID: "id", NAME: "name" },
    },
  };
}

describe("buildFolderViews", () => {
  it("offers My Drive, shared drives and shared-with-me", () => {
    const { picker, views } = fakePicker();
    const built = buildFolderViews(picker);

    expect(built).toHaveLength(3);
    expect(views.map((v) => v.label)).toEqual(["My Drive", "Shared drives", "Shared with me"]);
  });

  it("makes every view folders-only and folder-selectable", () => {
    const { picker, views } = fakePicker();
    buildFolderViews(picker);

    for (const view of views) {
      expect(view.viewId).toBe("folders");
      expect(view.selectFolderEnabled).toBe(true);
      expect(view.includeFolders).toBe(true);
      // `drive.file` grants no thumbnail access, so the default grid would be
      // rows of blanks.
      expect(view.mode).toBe("list");
    }
  });

  it("filters to folders in the file views, but not in the shared drives view", () => {
    const { picker, views } = fakePicker();
    buildFolderViews(picker);

    expect(views[0].mimeTypes).toBe(FOLDER_MIME_TYPE);
    expect(views[2].mimeTypes).toBe(FOLDER_MIME_TYPE);
    // Shared drives themselves aren't folder-mimetyped: filtering here would
    // leave the tab empty with nothing to navigate into.
    expect(views[1].mimeTypes).toBeUndefined();
  });

  it("browses My Drive from the root instead of listing every folder flat", () => {
    const { picker, views } = fakePicker();
    buildFolderViews(picker);

    expect(views[0].parent).toBe("root");
    // Only the My Drive view is rooted: the other two would show nothing.
    expect(views[1].parent).toBeUndefined();
    expect(views[2].parent).toBeUndefined();
  });

  it("reaches shared drives from the shared drives view only", () => {
    const { picker, views } = fakePicker();
    buildFolderViews(picker);

    expect(views[1].enableDrives).toBe(true);
    expect(views[2].ownedByMe).toBe(false);
    // Google documents these as mutually exclusive: set together, the view
    // returns nothing at all.
    expect(views[1].ownedByMe).toBeUndefined();
    expect(views[2].enableDrives).toBeUndefined();
  });
});

describe("readPickerResponse", () => {
  const { picker } = fakePicker();

  it("reads the chosen folder out of a pick", () => {
    const result = readPickerResponse(picker, {
      action: "picked",
      docs: [{ id: "folder-1", name: "Waivers" }],
    });

    expect(result).toEqual({ status: "picked", folder: { id: "folder-1", name: "Waivers" } });
  });

  it("reports a cancel", () => {
    expect(readPickerResponse(picker, { action: "cancel" })).toEqual({ status: "cancelled" });
  });

  it("ignores the intermediate callbacks the picker fires", () => {
    // These must not be read as a cancellation, or the dialog would resolve to
    // "no folder chosen" while the manager is still browsing.
    expect(readPickerResponse(picker, { action: "loaded" })).toEqual({ status: "pending" });
    expect(readPickerResponse(picker, {})).toEqual({ status: "pending" });
  });

  it("treats a pick with no documents as nothing chosen", () => {
    expect(readPickerResponse(picker, { action: "picked", docs: [] })).toEqual({
      status: "picked",
      folder: null,
    });
  });
});

describe("buildFolderPicker", () => {
  it("sets the developer key, token, app id and origin the pick depends on", () => {
    // Google checks all four when the manager presses Select, and rejects them
    // silently: a picker missing any of them browses fine and then swallows the
    // pick, leaving a greyed-out button and no callback. That was the bug.
    const { picker, built } = fakePicker();

    buildFolderPicker(picker, {
      token: "tok-1",
      developerKey: "AIza-key",
      appId: "123456789012",
      origin: "https://jitsu.au",
      onResponse: () => {},
    });

    expect(built.calls.developerKey).toBe("AIza-key");
    expect(built.calls.oauthToken).toBe("tok-1");
    expect(built.calls.appId).toBe("123456789012");
    expect(built.calls.origin).toBe("https://jitsu.au");
    expect(built.addedViews).toBe(3);
  });

  it("still builds when the client id yielded no app id", () => {
    const { picker, built } = fakePicker();

    buildFolderPicker(picker, {
      token: "tok-1",
      developerKey: "AIza-key",
      appId: null,
      origin: "https://jitsu.au",
      onResponse: () => {},
    });

    expect(built.calls.appId).toBeUndefined();
  });
});

describe("accountMismatchMessage", () => {
  it("names both accounts when the picker signed in as someone else", () => {
    const message = accountMismatchMessage("personal@gmail.com", "club@jitsu.au");
    expect(message).toContain("personal@gmail.com");
    expect(message).toContain("club@jitsu.au");
  });

  it("says nothing when the accounts match, whatever the casing", () => {
    expect(accountMismatchMessage("Club@Jitsu.au", "club@jitsu.au ")).toBeNull();
  });

  it("says nothing when either account is unknown", () => {
    // Drive not answering `about.get` is not a reason to block the manager.
    expect(accountMismatchMessage(null, "club@jitsu.au")).toBeNull();
    expect(accountMismatchMessage("club@jitsu.au", null)).toBeNull();
  });
});

describe("pickDriveFolder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    delete window.google;
    delete window.gapi;
  });

  /**
   * Stands in for Google's globals. The script tags are pre-inserted because
   * `loadScript` short-circuits on a matching `src`, which is the only way this
   * flow can run without the network.
   */
  function stubGoogle(opts: { accountEmail?: string | null } = {}) {
    for (const src of [
      "https://accounts.google.com/gsi/client",
      "https://apis.google.com/js/api.js",
    ]) {
      const script = document.createElement("script");
      script.src = src;
      document.head.appendChild(script);
    }

    const { picker, built } = fakePicker();
    const tokenConfig: Recorded = {};
    window.gapi = { load: (_api: string, cb: () => void) => cb() };
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => {
            Object.assign(tokenConfig, config);
            return { requestAccessToken: () => config.callback({ access_token: "tok-1" }) };
          },
        },
      },
      picker,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: opts.accountEmail !== undefined,
        json: async () => ({ user: { emailAddress: opts.accountEmail } }),
      }),
    );

    return { built, tokenConfig };
  }

  it("hands back the folder the manager picked", async () => {
    const { built } = stubGoogle({ accountEmail: "club@jitsu.au" });

    const pending = pickDriveFolder({
      clientId: "123456789012-abc.apps.googleusercontent.com",
      developerKey: "AIza-key",
      connectedEmail: "club@jitsu.au",
    });
    await vi.waitFor(() => expect(built.visible).toBe(true));
    built.respond({ action: "picked", docs: [{ id: "folder-1", name: "Waivers" }] });

    await expect(pending).resolves.toEqual({ id: "folder-1", name: "Waivers" });
  });

  it("asks Google for the account the site is connected as", async () => {
    // Without the hint the popup silently uses the browser's default account,
    // and a pick made as the wrong one only fails later, server-side.
    const { built, tokenConfig } = stubGoogle({ accountEmail: "club@jitsu.au" });

    const pending = pickDriveFolder({
      clientId: "123456789012-abc.apps.googleusercontent.com",
      developerKey: "AIza-key",
      connectedEmail: "club@jitsu.au",
    });
    await vi.waitFor(() => expect(built.visible).toBe(true));
    built.respond({ action: "cancel" });

    await expect(pending).resolves.toBeNull();
    expect(tokenConfig.hint).toBe("club@jitsu.au");
  });

  it("refuses to open when Google signed the manager in as another account", async () => {
    const { built } = stubGoogle({ accountEmail: "personal@gmail.com" });

    await expect(
      pickDriveFolder({
        clientId: "123456789012-abc.apps.googleusercontent.com",
        developerKey: "AIza-key",
        connectedEmail: "club@jitsu.au",
      }),
    ).rejects.toThrow(/personal@gmail\.com/);
    expect(built.visible).toBe(false);
  });
});

describe("appIdFromClientId", () => {
  it("takes the project number off an OAuth client id", () => {
    expect(appIdFromClientId("123456789012-abcdef.apps.googleusercontent.com")).toBe(
      "123456789012",
    );
  });

  it("returns null when the client id has no leading project number", () => {
    expect(appIdFromClientId("not-a-client-id")).toBeNull();
    expect(appIdFromClientId("")).toBeNull();
  });
});
