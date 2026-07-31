// `resolvePickedFolder` is the one bit of business logic behind the Google
// Picker folder-save flow: everything else in google-drive.functions.ts is a
// `createServerFn` handler, which (like checkin.functions.ts's
// `applyCoverage`) cannot be called from the test runner directly. This pins
// the rule that matters — a folder the server-side connection can't see (a
// different Google account than the one connected, or a non-folder file id)
// must be rejected rather than silently saved.
import { describe, expect, it } from "vitest";
import { resolvePickedFolder, shouldRecreateFolder } from "./google-drive.functions";

function fakeResponse(init: { ok: boolean; body?: unknown }): Response {
  return {
    ok: init.ok,
    json: async () => init.body,
  } as Response;
}

describe("resolvePickedFolder", () => {
  it("returns the folder's canonical id and name", async () => {
    const fetchFolder = async (folderId: string) => {
      expect(folderId).toBe("folder-123");
      return fakeResponse({
        ok: true,
        body: {
          id: "folder-123",
          name: "UTS Jitsu Waivers",
          mimeType: "application/vnd.google-apps.folder",
        },
      });
    };

    const result = await resolvePickedFolder(fetchFolder, "folder-123");
    expect(result).toEqual({ id: "folder-123", name: "UTS Jitsu Waivers" });
  });

  it("falls back to a placeholder name when Drive returns none", async () => {
    const fetchFolder = async () =>
      fakeResponse({
        ok: true,
        body: { id: "folder-123", mimeType: "application/vnd.google-apps.folder" },
      });

    const result = await resolvePickedFolder(fetchFolder, "folder-123");
    expect(result.name).toBe("Untitled folder");
  });

  it("rejects a folder the server-side connection can't see", async () => {
    const fetchFolder = async () => fakeResponse({ ok: false });

    await expect(resolvePickedFolder(fetchFolder, "folder-123")).rejects.toThrow(
      /same Google account/i,
    );
  });

  it("rejects a picked id that isn't a folder", async () => {
    const fetchFolder = async () =>
      fakeResponse({
        ok: true,
        body: { id: "file-123", name: "waiver.pdf", mimeType: "application/pdf" },
      });

    await expect(resolvePickedFolder(fetchFolder, "file-123")).rejects.toThrow(/isn't a folder/i);
  });
});

// Re-resolving the folder name creates the folder when the search misses, so
// every `true` here is a licence to silently move where a club's signed
// waivers land. The rules are worth pinning individually.
describe("shouldRecreateFolder", () => {
  it("recreates a name-configured folder Drive says is gone", () => {
    expect(shouldRecreateFolder({ status: 404, folderSource: "name" })).toBe(true);
  });

  it("treats a connection saved before folderSource existed as name-configured", () => {
    expect(shouldRecreateFolder({ status: 404, folderSource: undefined })).toBe(true);
    expect(shouldRecreateFolder({ status: 404, folderSource: null })).toBe(true);
  });

  it("never recreates a folder the manager picked", () => {
    // Its name is not where it lives: recreating by name would land waivers in
    // My Drive when they chose a shared drive.
    expect(shouldRecreateFolder({ status: 404, folderSource: "picker" })).toBe(false);
  });

  it("leaves a folder that still exists alone", () => {
    // 403 is a permission problem, 5xx is Drive's problem, and an error with no
    // status at all says nothing about the folder.
    for (const status of [403, 429, 500, 503, null]) {
      expect(shouldRecreateFolder({ status, folderSource: "name" })).toBe(false);
    }
  });
});
