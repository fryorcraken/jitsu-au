import { beforeEach, describe, expect, it } from "vitest";
import { clearLastVisit, readLastVisit, writeLastVisit } from "@/lib/last-visit";

beforeEach(() => {
  window.localStorage.clear();
});

describe("last visit", () => {
  it("reads back what was written, dated", () => {
    const before = Date.now();
    writeLastVisit("user-1", "/kb/your-first-class", true);
    const visit = readLastVisit("user-1");

    expect(visit?.path).toBe("/kb/your-first-class");
    expect(visit?.hasSession).toBe(true);
    expect(visit?.at).toBeGreaterThanOrEqual(before);
  });

  it("keeps a signed-out visit under its own slot", () => {
    writeLastVisit(null, "/pricing", false);
    expect(readLastVisit(null)?.path).toBe("/pricing");
    // Not offered to somebody who has since signed in — that is a different
    // owner, and `resolveLaunchTarget` refuses the mismatch anyway.
    expect(readLastVisit("user-1")).toBeNull();
  });

  it("does not return one manager's last screen to the next person", () => {
    writeLastVisit("user-1", "/manager/check-in", true);
    expect(readLastVisit("user-2")).toBeNull();
  });

  it("clears", () => {
    writeLastVisit("user-1", "/account", true);
    clearLastVisit();
    expect(readLastVisit("user-1")).toBeNull();
  });

  it("returns null rather than throwing on rubbish in storage", () => {
    writeLastVisit("user-1", "/account", true);
    const key = Object.keys(window.localStorage).find((k) => k.includes("last-visit"))!;
    window.localStorage.setItem(key, "{not json");
    expect(readLastVisit("user-1")).toBeNull();
  });
});
