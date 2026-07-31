// The picker's *view configuration* is the whole product behaviour here: get
// it wrong and the manager is asked to select a file, or can only see the
// folders in their own My Drive. `pickDriveFolder` itself is a thin wrapper
// around Google's globals (script loading, OAuth popup) that can't run under
// the test runner, so the parts worth pinning are extracted: which views the
// picker opens with, and the app id derivation `drive.file` grants depend on.
import { describe, expect, it } from "vitest";
import {
  appIdFromClientId,
  buildFolderViews,
  FOLDER_MIME_TYPE,
  type GooglePickerNamespace,
  type GooglePickerView,
} from "./google-picker";

type Recorded = Record<string, unknown>;

function fakePicker(): { picker: GooglePickerNamespace; views: Recorded[] } {
  const views: Recorded[] = [];

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

  return {
    views,
    picker: {
      ViewId: { FOLDERS: "folders" },
      DocsViewMode: { LIST: "list", GRID: "grid" },
      DocsView: FakeDocsView,
      PickerBuilder: class {} as unknown as GooglePickerNamespace["PickerBuilder"],
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
      expect(view.mimeTypes).toBe(FOLDER_MIME_TYPE);
      expect(view.selectFolderEnabled).toBe(true);
      expect(view.includeFolders).toBe(true);
      // `drive.file` grants no thumbnail access, so the default grid would be
      // rows of blanks.
      expect(view.mode).toBe("list");
    }
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
