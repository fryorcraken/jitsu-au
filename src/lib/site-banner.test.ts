import { describe, expect, it } from "vitest";
import {
  SITE_BANNER_STORAGE_KEY,
  shouldDropSiteBannerLink,
  persistDismissedSiteBanner,
  readDismissedSiteBanner,
  siteBannerFingerprint,
} from "./site-banner";

const BANNER = {
  message: "Free trials are paused for now.",
  link_label: "Register your interest",
  link_href: "/register-interest",
};

// A minimal in-memory Storage stand-in for the getItem/setItem surface used.
function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("siteBannerFingerprint", () => {
  it("is the same for the same banner", () => {
    expect(siteBannerFingerprint(BANNER)).toBe(siteBannerFingerprint({ ...BANNER }));
  });

  // Closing one notice is not agreeing to miss the next.
  it("changes when the message or the link changes", () => {
    const base = siteBannerFingerprint(BANNER);
    expect(siteBannerFingerprint({ ...BANNER, message: "Back at UTS from Monday." })).not.toBe(
      base,
    );
    expect(siteBannerFingerprint({ ...BANNER, link_href: "/classes" })).not.toBe(base);
    expect(siteBannerFingerprint({ ...BANNER, link_label: "Register" })).not.toBe(base);
  });

  it("does not run two fields together", () => {
    expect(siteBannerFingerprint({ message: "ab", link_label: "c", link_href: "" })).not.toBe(
      siteBannerFingerprint({ message: "a", link_label: "bc", link_href: "" }),
    );
  });
});

describe("dismissal", () => {
  it("reads nothing when nothing was closed", () => {
    expect(readDismissedSiteBanner(makeStorage())).toBeNull();
    expect(readDismissedSiteBanner(null)).toBeNull();
    expect(readDismissedSiteBanner(undefined)).toBeNull();
  });

  it("remembers which banner was closed", () => {
    const storage = makeStorage();
    const print = siteBannerFingerprint(BANNER);
    persistDismissedSiteBanner(storage, print);
    expect(storage.getItem(SITE_BANNER_STORAGE_KEY)).toBe(print);
    expect(readDismissedSiteBanner(storage)).toBe(print);
  });

  it("swallows storage errors", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readDismissedSiteBanner(throwing)).toBeNull();
    expect(() => persistDismissedSiteBanner(throwing, "abc")).not.toThrow();
  });
});

describe("shouldDropSiteBannerLink", () => {
  it("is true on the page the link points at", () => {
    expect(shouldDropSiteBannerLink("/register-interest", "/register-interest")).toBe(true);
    expect(shouldDropSiteBannerLink("/register-interest/", "/register-interest")).toBe(true);
    expect(shouldDropSiteBannerLink("/register-interest?from=banner", "/register-interest")).toBe(
      true,
    );
    expect(shouldDropSiteBannerLink("/", "/")).toBe(true);
  });

  // A stray tap on the banner must not carry somebody off a half-filled waiver.
  it("is true on the waiver, wherever the link goes", () => {
    expect(shouldDropSiteBannerLink("/register-interest", "/waiver")).toBe(true);
    expect(shouldDropSiteBannerLink("https://example.com/", "/waiver/")).toBe(true);
    expect(shouldDropSiteBannerLink("/classes", "/waiver-info")).toBe(false);
  });

  it("is false anywhere else, and for another site", () => {
    expect(shouldDropSiteBannerLink("/register-interest", "/")).toBe(false);
    expect(shouldDropSiteBannerLink("/register-interest", "/register-interest-old")).toBe(false);
    expect(shouldDropSiteBannerLink("https://example.com/", "/")).toBe(false);
  });
});
