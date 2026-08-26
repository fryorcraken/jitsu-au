import { beforeEach, describe, expect, it } from "vitest";
import {
  EDITOR_DRAFT_MAX_AGE_MS,
  clearEditorDraft,
  draftVerdict,
  editorDraftKey,
  readEditorDraft,
  reviveDraftFields,
  sameDraftFields,
  writeEditorDraft,
} from "@/lib/editor-draft";
import { LOCAL_CACHE_PREFIX } from "@/lib/local-cache";

type Fields = { title: string; body: string; published: boolean };
const shape: Fields = { title: "", body: "", published: false };

beforeEach(() => {
  window.localStorage.clear();
});

describe("draftVerdict", () => {
  const baseline: Fields = { title: "Belts", body: "One", published: false };

  it("says none when there is nothing stored", () => {
    expect(draftVerdict(null, baseline, sameDraftFields)).toBe("none");
  });

  it("offers a draft that differs from what was saved", () => {
    const stored: Fields = { ...baseline, body: "One and a half" };
    expect(draftVerdict(stored, baseline, sameDraftFields)).toBe("offer");
  });

  it("calls a draft matching the saved version stale, so it is not offered back", () => {
    expect(draftVerdict({ ...baseline }, baseline, sameDraftFields)).toBe("stale");
  });

  it("notices a difference in a boolean field, not just the text", () => {
    expect(draftVerdict({ ...baseline, published: true }, baseline, sameDraftFields)).toBe("offer");
  });
});

describe("sameDraftFields", () => {
  it("compares every field on either side", () => {
    expect(sameDraftFields({ a: "1", b: "2" }, { a: "1", b: "2" })).toBe(true);
    expect(sameDraftFields({ a: "1", b: "2" }, { a: "1", b: "3" })).toBe(false);
    // A field present on one side only counts as a difference, even when its
    // value is the empty string. In practice both sides always carry the full
    // field list (a stored draft comes back through `reviveDraftFields`, which
    // fills every field from the shape), so this is about never quietly
    // treating "absent" and "blank" as the same thing.
    expect(sameDraftFields({ a: "1", b: "" }, { a: "1" } as Record<string, string>)).toBe(false);
  });
});

describe("reviveDraftFields", () => {
  const revive = reviveDraftFields(shape);

  it("fills in a field that is missing or the wrong type from the shape", () => {
    // A draft written before `published` existed must restore, not be binned:
    // the alternative loses somebody's half-written article over a field they
    // never set.
    expect(revive({ title: "Belts", body: "One" })).toEqual({
      title: "Belts",
      body: "One",
      published: false,
    });
    expect(revive({ title: 7, body: null, published: "yes" })).toEqual(shape);
  });

  it("ignores fields it was not asked for", () => {
    expect(revive({ ...shape, sneaky: "value" })).toEqual(shape);
  });

  it("refuses anything that is not an object", () => {
    expect(revive(null)).toBeNull();
    expect(revive("text")).toBeNull();
    expect(revive(7)).toBeNull();
  });
});

describe("storage", () => {
  it("keeps drafts of different documents apart", () => {
    expect(editorDraftKey("blog-post", "new")).not.toBe(editorDraftKey("blog-post", "abc"));

    writeEditorDraft("blog-post", "new", "user-1", { ...shape, title: "Untitled" });
    writeEditorDraft("blog-post", "abc", "user-1", { ...shape, title: "Belts" });

    expect(readEditorDraft("blog-post", "new", "user-1", shape)?.data.title).toBe("Untitled");
    expect(readEditorDraft("blog-post", "abc", "user-1", shape)?.data.title).toBe("Belts");
  });

  it("does not hand one manager's draft to whoever signs in next", () => {
    writeEditorDraft("blog-post", "new", "user-1", { ...shape, title: "Belts" });
    expect(readEditorDraft("blog-post", "new", "user-2", shape)).toBeNull();
  });

  it("clears a draft", () => {
    writeEditorDraft("blog-post", "new", "user-1", { ...shape, title: "Belts" });
    clearEditorDraft("blog-post", "new");
    expect(readEditorDraft("blog-post", "new", "user-1", shape)).toBeNull();
  });

  it("forgets a draft nobody came back for", () => {
    const key = `${LOCAL_CACHE_PREFIX}${editorDraftKey("blog-post", "new")}`;
    writeEditorDraft("blog-post", "new", "user-1", { ...shape, title: "Belts" });
    const stored = JSON.parse(window.localStorage.getItem(key)!);
    stored.at = Date.now() - EDITOR_DRAFT_MAX_AGE_MS - 1;
    window.localStorage.setItem(key, JSON.stringify(stored));

    expect(readEditorDraft("blog-post", "new", "user-1", shape)).toBeNull();
  });
});
