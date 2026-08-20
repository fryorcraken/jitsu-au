import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_PAGES } from "../src/lib/public-pages";
import {
  fillRouteParams,
  personaFor,
  publicPaths,
  routeFileToPath,
  signedInPaths,
  signedInPathsByPersona,
} from "./site-pages";

/** The real route files, the way the tour lists them. Vitest runs at the repo root. */
function realRouteFiles() {
  return readdirSync(resolve(process.cwd(), "src/routes"), { recursive: true }).map(String).sort();
}

describe("routeFileToPath", () => {
  it("reads dots as path separators", () => {
    expect(routeFileToPath("_authenticated/manager.waivers.tsx")).toBe("/manager/waivers");
  });

  it("drops the pathless group directory", () => {
    expect(routeFileToPath("_authenticated/account.tsx")).toBe("/account");
  });

  it("lets an index name its parent", () => {
    expect(routeFileToPath("_authenticated/manager.index.tsx")).toBe("/manager");
    expect(routeFileToPath("kb/index.tsx")).toBe("/kb");
  });

  it("keeps the path of a segment that only escapes layout nesting", () => {
    expect(routeFileToPath("_authenticated/manager.users_.$userId.tsx")).toBe(
      "/manager/users/$userId",
    );
    expect(routeFileToPath("_authenticated/manager.blog_.new.tsx")).toBe("/manager/blog/new");
  });

  it("skips layout routes, tests and non-route files", () => {
    expect(routeFileToPath("_authenticated/route.tsx")).toBeNull();
    expect(routeFileToPath("kb/route.tsx")).toBeNull();
    expect(routeFileToPath("_authenticated/account.test.tsx")).toBeNull();
    expect(routeFileToPath("_authenticated/README.md")).toBeNull();
  });
});

describe("signedInPaths", () => {
  it("takes only the gated directories, deduplicated and ordered", () => {
    expect(
      signedInPaths([
        "index.tsx",
        "blog/index.tsx",
        "kb/route.tsx",
        "kb/index.tsx",
        "kb/$slug.tsx",
        "_authenticated/route.tsx",
        "_authenticated/account.tsx",
        "_authenticated/account.test.tsx",
        "_authenticated/manager.index.tsx",
      ]),
    ).toEqual(["/account", "/kb", "/kb/$slug", "/manager"]);
  });

  it("leaves public pages to src/lib/seo.ts", () => {
    expect(signedInPaths(["index.tsx", "pricing.tsx", "blog/$slug.tsx"])).toEqual([]);
  });
});

describe("publicPaths", () => {
  it("walks the sitemap first, then the noindex pages nothing else can derive", () => {
    const paths = publicPaths();
    expect(paths.slice(0, PUBLIC_PAGES.length)).toEqual(PUBLIC_PAGES.map((page) => page.path));
    expect(paths).toContain("/waiver");
    expect(paths).toContain("/auth");
  });

  it("never lists a page twice, so no shot overwrites another", () => {
    const paths = publicPaths();
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("personaFor", () => {
  it("walks manager screens as a manager", () => {
    expect(personaFor("/manager")).toBe("manager");
    expect(personaFor("/manager/waivers")).toBe("manager");
  });

  it("walks the member area as a member", () => {
    expect(personaFor("/account")).toBe("member");
    expect(personaFor("/kb/welcome")).toBe("member");
  });

  it("does not treat a lookalike path as the manager area", () => {
    expect(personaFor("/managerial")).toBe("member");
  });
});

describe("fillRouteParams", () => {
  it("substitutes by the parameter's own name", () => {
    expect(fillRouteParams("/manager/users/$userId", { userId: "abc" })).toBe("/manager/users/abc");
    expect(fillRouteParams("/kb/$slug", { slug: "welcome" })).toBe("/kb/welcome");
  });

  it("leaves a static path alone", () => {
    expect(fillRouteParams("/account", {})).toBe("/account");
  });

  it("reports a missing value rather than walking into a 404", () => {
    expect(fillRouteParams("/kb/$slug", {})).toBeNull();
    expect(fillRouteParams("/kb/$slug", undefined)).toBeNull();
  });
});

describe("routeFileToPath, on the shapes src/routes/README.md documents", () => {
  it("refuses a layout file rather than claiming the home page", () => {
    // `/` would be the home page's own path, so the member-area render of a
    // layout would be walked and photographed as the home page, and the
    // gallery would show one picture under two headings.
    expect(routeFileToPath("_authenticated/_layout.tsx")).toBeNull();
    expect(routeFileToPath("_authenticated/_pathless._other.tsx")).toBeNull();
  });

  it("keeps an escaped dot in the URL instead of reading it as a separator", () => {
    expect(routeFileToPath("kb/feed[.]json.tsx")).toBe("/kb/feed.json");
  });

  it("keeps an optional parameter recognisable as a parameter", () => {
    expect(routeFileToPath("_authenticated/posts.{-$category}.tsx")).toBe("/posts/{-$category}");
    expect(fillRouteParams("/posts/{-$category}", { category: "news" })).toBe("/posts/news");
    expect(fillRouteParams("/posts/{-$category}", {})).toBeNull();
  });
});

describe("signedInPaths, against the real src/routes tree", () => {
  // The hand-written lists above prove the rules; this proves they still
  // describe this repo. It is the test that catches a new route file whose
  // shape the derivation mishandles — which is how the tour would silently
  // stop covering a screen.
  const paths = signedInPaths(realRouteFiles());

  it("finds the member area and every manager screen", () => {
    expect(paths).toEqual([
      "/account",
      "/kb",
      "/kb/$slug",
      "/manager",
      "/manager/api-tokens",
      "/manager/blog",
      "/manager/blog-comments",
      "/manager/blog/$id",
      "/manager/blog/new",
      "/manager/calendar",
      "/manager/check-in",
      "/manager/contact-messages",
      "/manager/kb",
      "/manager/membership-plans",
      "/manager/memberships",
      "/manager/reconciliation",
      "/manager/settings",
      "/manager/users",
      "/manager/users/$userId",
      "/manager/waiver-template",
      "/manager/waivers",
      "/manager/waivers/upload",
      "/membership",
      "/notifications",
    ]);
  });

  it("never derives the same path twice, so no shot overwrites another", () => {
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("signedInPathsByPersona", () => {
  const files = [
    "_authenticated/account.tsx",
    "_authenticated/manager.index.tsx",
    "_authenticated/manager.users_.$userId.tsx",
  ];
  const params = { userId: "abc" };

  it("splits the pages by who has to be signed in, parameters filled", () => {
    expect(signedInPathsByPersona(files, params)).toEqual({
      member: ["/account"],
      manager: ["/manager", "/manager/users/abc"],
    });
  });

  it("fails on a parameter the fixture cannot fill, rather than skipping the screen", () => {
    expect(() => signedInPathsByPersona(files, {})).toThrow(/no fixture value for .*\$userId/);
  });

  it("fails when a persona has no pages, which means the derivation broke", () => {
    expect(() => signedInPathsByPersona(["_authenticated/manager.index.tsx"], params)).toThrow(
      /no member pages/,
    );
  });
});
