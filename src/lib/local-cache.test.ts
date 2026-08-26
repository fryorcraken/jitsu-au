import { beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_CACHE_PREFIX,
  clearCacheFor,
  packCache,
  readCache,
  removeCache,
  unpackCache,
  writeCache,
} from "@/lib/local-cache";

const revive = (value: unknown) =>
  value && typeof value === "object" ? (value as { note?: string }) : null;

const terms = { version: 1, owner: "user-1", revive };

beforeEach(() => {
  window.localStorage.clear();
});

describe("unpackCache", () => {
  it("reads back what packCache wrote", () => {
    const raw = packCache({ note: "hi" }, 1, "user-1", 1_000);
    expect(unpackCache(raw, terms, 2_000)).toEqual({ data: { note: "hi" }, savedAt: 1_000 });
  });

  it("refuses an entry written by an older payload version", () => {
    const raw = packCache({ note: "hi" }, 0, "user-1", 1_000);
    expect(unpackCache(raw, terms, 2_000)).toBeNull();
  });

  it("refuses an entry belonging to somebody else", () => {
    // The rule that keeps one member's data off the next member's screen on a
    // shared club laptop.
    const raw = packCache({ note: "hi" }, 1, "user-2", 1_000);
    expect(unpackCache(raw, terms, 2_000)).toBeNull();
    expect(unpackCache(raw, { ...terms, owner: "user-2" }, 2_000)).not.toBeNull();
  });

  it("refuses an entry older than maxAgeMs, and accepts one inside it", () => {
    const raw = packCache({ note: "hi" }, 1, "user-1", 1_000);
    expect(unpackCache(raw, { ...terms, maxAgeMs: 500 }, 2_000)).toBeNull();
    expect(unpackCache(raw, { ...terms, maxAgeMs: 5_000 }, 2_000)).not.toBeNull();
  });

  it("does not hide an entry because the device clock moved backwards", () => {
    // A phone correcting its clock would otherwise make a just-written entry
    // look like one from the future and, with maxAgeMs, unreadable forever.
    const raw = packCache({ note: "hi" }, 1, "user-1", 9_000);
    expect(unpackCache(raw, { ...terms, maxAgeMs: 1_000 }, 2_000)).not.toBeNull();
  });

  it("never throws on rubbish", () => {
    expect(unpackCache(null, terms, 0)).toBeNull();
    expect(unpackCache("", terms, 0)).toBeNull();
    expect(unpackCache("{not json", terms, 0)).toBeNull();
    expect(unpackCache("42", terms, 0)).toBeNull();
    expect(unpackCache('{"v":1,"o":"user-1"}', terms, 0)).toBeNull();
  });

  it("rejects an entry whose payload the caller's revive refuses", () => {
    const raw = packCache("not an object", 1, "user-1", 1_000);
    expect(unpackCache(raw, terms, 2_000)).toBeNull();
  });
});

describe("storage", () => {
  it("round-trips through localStorage under the app's prefix", () => {
    writeCache("thing", { note: "hi" }, 1, "user-1", 1_000);
    expect(window.localStorage.getItem(`${LOCAL_CACHE_PREFIX}thing`)).toBeTruthy();
    expect(readCache("thing", terms, 2_000)?.data).toEqual({ note: "hi" });
  });

  it("drops an entry it had to reject rather than leaving it against the quota", () => {
    writeCache("thing", { note: "hi" }, 1, "user-2", 1_000);
    expect(readCache("thing", terms, 2_000)).toBeNull();
    expect(window.localStorage.getItem(`${LOCAL_CACHE_PREFIX}thing`)).toBeNull();
  });

  it("removes one entry", () => {
    writeCache("thing", { note: "hi" }, 1, "user-1", 1_000);
    removeCache("thing");
    expect(readCache("thing", terms, 2_000)).toBeNull();
  });

  it("clears only the entries belonging to one person", () => {
    writeCache("mine", { note: "a" }, 1, "user-1", 1_000);
    writeCache("theirs", { note: "b" }, 1, "user-2", 1_000);
    window.localStorage.setItem("unrelated", "leave me alone");

    clearCacheFor("user-1");

    expect(readCache("mine", terms, 2_000)).toBeNull();
    expect(readCache("theirs", { ...terms, owner: "user-2" }, 2_000)?.data).toEqual({ note: "b" });
    expect(window.localStorage.getItem("unrelated")).toBe("leave me alone");
  });

  it("clears every entry when given no owner", () => {
    writeCache("mine", { note: "a" }, 1, "user-1", 1_000);
    writeCache("theirs", { note: "b" }, 1, "user-2", 1_000);
    window.localStorage.setItem("unrelated", "leave me alone");

    clearCacheFor();

    expect(readCache("mine", terms, 2_000)).toBeNull();
    expect(readCache("theirs", { ...terms, owner: "user-2" }, 2_000)).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("leave me alone");
  });
});
