import { describe, expect, it } from "vitest";
import {
  SITE_BANNER_COOKIE,
  dismissSiteBannerCookie,
  readDismissedSiteBanner,
  shouldDropSiteBannerLink,
  siteBannerFingerprint,
  siteBannerLocalHref,
  siteBannerNavigatesInApp,
} from "./site-banner";
import { SITE_ORIGIN } from "./site-origin";

const BANNER = {
  message: "Free trials are paused for now.",
  link_label: "Register your interest",
  link_href: "/register-interest",
};

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

describe("dismissal cookie", () => {
  it("reads nothing when nothing was closed", () => {
    expect(readDismissedSiteBanner(null)).toBeNull();
    expect(readDismissedSiteBanner(undefined)).toBeNull();
    expect(readDismissedSiteBanner("")).toBeNull();
    expect(readDismissedSiteBanner("sb-auth=abc; theme=dark")).toBeNull();
  });

  it("reads the closed banner back out of a Cookie header, among others", () => {
    const print = siteBannerFingerprint(BANNER);
    expect(readDismissedSiteBanner(`theme=dark; ${SITE_BANNER_COOKIE}=${print}; x=1`)).toBe(print);
    expect(readDismissedSiteBanner(`${SITE_BANNER_COOKIE}=${print}`)).toBe(print);
  });

  // What the browser stores is what the server reads on the next page.
  it("writes a cookie the same reader understands", () => {
    const print = siteBannerFingerprint(BANNER);
    const cookie = dismissSiteBannerCookie(print, true);
    expect(readDismissedSiteBanner(cookie.split(";")[0])).toBe(print);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(dismissSiteBannerCookie(print, false)).not.toContain("Secure");
  });
});

describe("siteBannerLocalHref", () => {
  it("keeps a page on this site as it is", () => {
    expect(siteBannerLocalHref("/faq#trial")).toBe("/faq#trial");
  });

  it("treats a full address to this site as this site", () => {
    expect(siteBannerLocalHref(`${SITE_ORIGIN}/register-interest`)).toBe("/register-interest");
    expect(siteBannerLocalHref(SITE_ORIGIN)).toBe("/");
  });

  it("is null for another site, including one that merely starts the same", () => {
    expect(siteBannerLocalHref("https://example.com/")).toBeNull();
    expect(siteBannerLocalHref(`${SITE_ORIGIN}.evil.example/`)).toBeNull();
  });
});

describe("siteBannerNavigatesInApp", () => {
  it("moves within the app to a page", () => {
    for (const href of ["/", "/classes", "/faq#trial", "/blog/grading-day?from=banner"]) {
      expect(siteBannerNavigatesInApp(href), href).toBe(true);
    }
  });

  // The router would draw its 404 page over these instead of loading them.
  it("leaves a file or a server route to the browser", () => {
    for (const href of ["/timetable.pdf", "/sitemap.xml", "/api/calendar", "/lovable/x"]) {
      expect(siteBannerNavigatesInApp(href), href).toBe(false);
    }
  });
});

describe("shouldDropSiteBannerLink", () => {
  it("drops it on the page the link points at", () => {
    expect(shouldDropSiteBannerLink("/classes", "/classes")).toBe(true);
    expect(shouldDropSiteBannerLink("/classes/", "/classes")).toBe(true);
    expect(shouldDropSiteBannerLink("/classes?from=banner", "/classes")).toBe(true);
    expect(shouldDropSiteBannerLink(`${SITE_ORIGIN}/classes`, "/classes")).toBe(true);
    expect(shouldDropSiteBannerLink("/", "/")).toBe(true);
  });

  // Jumping to a section of the page you are on is the point of such a link.
  it("keeps a link to a section of this page", () => {
    expect(shouldDropSiteBannerLink("/faq#trial", "/faq")).toBe(false);
  });

  // A stray tap on the banner must not carry somebody off a half-filled form.
  it("drops it on every form, wherever it goes", () => {
    for (const here of ["/waiver", "/waiver/", "/register-interest", "/contact"]) {
      expect(shouldDropSiteBannerLink("https://example.com/", here), here).toBe(true);
      expect(shouldDropSiteBannerLink("/faq#trial", here), here).toBe(true);
    }
    expect(shouldDropSiteBannerLink("/classes", "/waiver-info")).toBe(false);
  });

  it("keeps it anywhere else", () => {
    expect(shouldDropSiteBannerLink("/register-interest", "/")).toBe(false);
    expect(shouldDropSiteBannerLink("/classes", "/classes-old")).toBe(false);
    expect(shouldDropSiteBannerLink("https://example.com/", "/")).toBe(false);
  });
});
