import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  KNOWN_MEMBER_KEY,
  PWA_LAUNCH_PATH,
  hasSignedInBefore,
  rememberSignedIn,
  resolveLaunchScreen,
} from "./pwa";

describe("resolveLaunchScreen", () => {
  it("opens the member area when there is a session", () => {
    expect(resolveLaunchScreen({ hasSession: true, hasSignedInBefore: true })).toBe("member");
  });

  it("opens the member area even on a device with no sign-in history", () => {
    // A live session is proof enough on its own; the history flag is only the
    // fallback for when the session has gone.
    expect(resolveLaunchScreen({ hasSession: true, hasSignedInBefore: false })).toBe("member");
  });

  it("sends a lapsed member to sign in", () => {
    expect(resolveLaunchScreen({ hasSession: false, hasSignedInBefore: true })).toBe("sign-in");
  });

  it("sends someone who has never signed in to the public home page", () => {
    // There is no self-serve sign-up, so a sign-in form would be a dead end for
    // a prospective member who installed the app from the website.
    expect(resolveLaunchScreen({ hasSession: false, hasSignedInBefore: false })).toBe("home");
  });
});

describe("sign-in history", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is false until someone signs in", () => {
    expect(hasSignedInBefore()).toBe(false);
  });

  it("is remembered across launches once someone signs in", () => {
    rememberSignedIn();
    expect(localStorage.getItem(KNOWN_MEMBER_KEY)).toBe("1");
    expect(hasSignedInBefore()).toBe(true);
  });

  it("ignores any other stored value", () => {
    localStorage.setItem(KNOWN_MEMBER_KEY, "maybe");
    expect(hasSignedInBefore()).toBe(false);
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
