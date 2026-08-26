import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_RESUME_WINDOW_MS,
  PWA_LAUNCH_PATH,
  isResumablePath,
  resolveLaunchScreen,
  resolveLaunchTarget,
} from "./pwa";

describe("resolveLaunchScreen", () => {
  it("opens the member area when there is a session", () => {
    expect(resolveLaunchScreen({ hasSession: true })).toBe("member");
  });

  it("sends anyone signed out to the public home page", () => {
    // Including a member whose session has lapsed: there is no self-serve
    // sign-up, so a sign-in screen would be a dead end for a prospective member
    // who installed the app off the website, and the home page header carries
    // "Member login" for everyone else.
    expect(resolveLaunchScreen({ hasSession: false })).toBe("home");
  });
});

describe("web manifest", () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "public", "manifest.webmanifest"), "utf8"),
  );

  it("launches through the route that picks the right screen", () => {
    // If these drift apart the installed app stops honouring the launch rule
    // above and opens on whatever `start_url` happens to name.
    expect(manifest.start_url).toBe(PWA_LAUNCH_PATH);
  });

  it("is installable: standalone, scoped to the site, with the required icons", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("/");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);

    const sizes = (purpose: string) =>
      manifest.icons
        .filter((icon: { purpose?: string }) =>
          (icon.purpose ?? "any").split(" ").includes(purpose),
        )
        .map((icon: { sizes: string }) => icon.sizes);

    // Chrome's install criteria: a 192px and a 512px icon, plus a maskable set
    // so Android does not letterbox the logo inside a white blob.
    expect(sizes("any")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(sizes("maskable")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });

  it("ships every icon and shortcut target it declares", () => {
    const publicDir = join(process.cwd(), "public");
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect(() => readFileSync(join(publicDir, icon.src))).not.toThrow();
    }
    for (const shortcut of manifest.shortcuts as Array<{ url: string }>) {
      expect(shortcut.url.startsWith("/")).toBe(true);
    }
  });
});

describe("isResumablePath", () => {
  it("allows the ordinary screens somebody could be looking at", () => {
    for (const path of ["/account", "/kb/your-first-class", "/manager/check-in", "/blog", "/"]) {
      expect(isResumablePath(path)).toBe(true);
    }
  });

  it("allows a path with a query string", () => {
    expect(isResumablePath("/manager/users?q=jane")).toBe(true);
  });

  it("refuses the launch route itself, which would loop", () => {
    expect(isResumablePath(PWA_LAUNCH_PATH)).toBe(false);
  });

  it("refuses a token-bearing path", () => {
    // `/email-settings/<token>` consumes its token and redirects, so coming
    // back to it later lands on a URL that no longer works.
    expect(isResumablePath("/email-settings/abc123")).toBe(false);
    expect(isResumablePath("/api/calendar/abc123")).toBe(false);
  });

  it("refuses the auth screens", () => {
    for (const path of [
      "/auth",
      "/auth?redirect=/account",
      "/reset-password",
      "/update-password",
    ]) {
      expect(isResumablePath(path)).toBe(false);
    }
  });

  it("refuses the tricks that make one parser disagree with another", () => {
    // This value is read back off the device, so it is the one input here an
    // attacker with any script foothold could choose. None of these can come
    // from a real navigation: a browser normalises them long before
    // `location.pathname` is readable.
    const bs = String.fromCharCode(92);
    expect(isResumablePath(`/${bs}evil.example`)).toBe(false);
    expect(isResumablePath(`/${bs}${bs}evil.example`)).toBe(false);
    expect(isResumablePath("/%5cevil.example")).toBe(false);
    // Traversal back out of a blocked prefix, raw and encoded.
    expect(isResumablePath("/x/../email-settings/token")).toBe(false);
    expect(isResumablePath("/x/%2e%2e/email-settings/token")).toBe(false);
    expect(isResumablePath("/x%2f%2e%2e/auth")).toBe(false);
    // A blocked screen reached through a spelling the list does not recognise.
    expect(isResumablePath("/Auth")).toBe(false);
    expect(isResumablePath("/EMAIL-SETTINGS/token")).toBe(false);
    expect(isResumablePath("/API/calendar/token")).toBe(false);
    // Control characters and whitespace, the classic smuggling vector.
    expect(isResumablePath("/account\n")).toBe(false);
    expect(isResumablePath("/\taccount")).toBe(false);
    expect(isResumablePath("/acc\u0000ount")).toBe(false);
    expect(isResumablePath("/account ")).toBe(false);
  });

  it("still allows the ordinary paths after all that", () => {
    // The hardening must not break the feature it guards.
    for (const path of ["/account", "/kb/your-first-class", "/manager/users?q=jane%20doe"]) {
      expect(isResumablePath(path)).toBe(true);
    }
  });

  it("refuses anything that is not a plain site-relative path", () => {
    // "//evil.example" is a protocol-relative URL, which a browser treats as
    // another origin. It must never reach a redirect.
    for (const path of ["//evil.example", "https://evil.example/x", "account", ""]) {
      expect(isResumablePath(path)).toBe(false);
    }
  });

  it("does not confuse a longer path with a blocked one", () => {
    // `/authors` is not `/auth`.
    expect(isResumablePath("/authors")).toBe(true);
  });
});

describe("resolveLaunchTarget", () => {
  const now = 1_000_000_000_000;
  const recent = { path: "/kb/your-first-class", at: now - 60_000, hasSession: true };

  it("returns to the screen the app was on", () => {
    // The whole point: a phone reclaimed the app mid-article, and the next tap
    // on the icon is a cold launch. Landing on the member home page instead is
    // what made that read as the app reloading itself.
    expect(resolveLaunchTarget({ hasSession: true, lastVisit: recent, now })).toEqual({
      path: "/kb/your-first-class",
    });
  });

  it("falls back to the usual launch screen when there is nothing recorded", () => {
    expect(resolveLaunchTarget({ hasSession: true, lastVisit: null, now })).toEqual({
      screen: "member",
    });
    expect(resolveLaunchTarget({ hasSession: false, lastVisit: null, now })).toEqual({
      screen: "home",
    });
  });

  it("does not return to a screen from days ago", () => {
    const old = { ...recent, at: now - LAUNCH_RESUME_WINDOW_MS - 1 };
    expect(resolveLaunchTarget({ hasSession: true, lastVisit: old, now })).toEqual({
      screen: "member",
    });
  });

  it("ignores a record from before the person signed out", () => {
    // Otherwise a launch drops them on a manager screen and bounces straight to
    // the sign-in page, which is worse than starting at the home page.
    expect(resolveLaunchTarget({ hasSession: false, lastVisit: recent, now })).toEqual({
      screen: "home",
    });
  });

  it("ignores a record from before the person signed in", () => {
    // They now want their member area, not the marketing page they were reading
    // before they had a login.
    const signedOutVisit = { path: "/pricing", at: now - 60_000, hasSession: false };
    expect(resolveLaunchTarget({ hasSession: true, lastVisit: signedOutVisit, now })).toEqual({
      screen: "member",
    });
  });

  it("ignores a record the device clock puts in the future", () => {
    const future = { ...recent, at: now + 60_000 };
    expect(resolveLaunchTarget({ hasSession: true, lastVisit: future, now })).toEqual({
      screen: "member",
    });
  });

  it("never resumes into a path it is not allowed to", () => {
    const blocked = { path: "/email-settings/token", at: now - 60_000, hasSession: true };
    expect(resolveLaunchTarget({ hasSession: true, lastVisit: blocked, now })).toEqual({
      screen: "member",
    });
  });
});
