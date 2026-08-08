import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fillRouteParams,
  personaFor,
  planSignedInGroups,
  routeFileToPath,
  signedInAvailability,
  signedInPaths,
} from "./pr-screenshots-pages.mjs";

/** The real route files, the way the entrypoint lists them. Vitest runs at the repo root. */
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

describe("personaFor", () => {
  it("shoots manager screens as a manager", () => {
    expect(personaFor("/manager")).toBe("manager");
    expect(personaFor("/manager/waivers")).toBe("manager");
  });

  it("shoots the member area as a member", () => {
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

  it("reports a missing value rather than photographing a 404", () => {
    expect(fillRouteParams("/kb/$slug", {})).toBeNull();
    expect(fillRouteParams("/kb/$slug", undefined)).toBeNull();
  });
});

describe("routeFileToPath, on the shapes src/routes/README.md documents", () => {
  it("refuses a layout file rather than claiming the home page", () => {
    // `/` would be the home page's own slug, so the member-area render of a
    // layout would overwrite home.png and the contact sheet would show one
    // picture under two headings.
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
  // shape the derivation mishandles — which is how the screenshot job would
  // silently stop covering a screen.
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

describe("signedInAvailability", () => {
  it("photographs the public pages alone when there is no seeded stack", () => {
    expect(signedInAvailability(false, false)).toBe("public-only");
  });

  it("calls half a setup out rather than quietly shrinking the run", () => {
    expect(signedInAvailability(false, true)).toBe("no-manifest");
    expect(signedInAvailability(true, false)).toBe("no-credentials");
  });

  it("signs in when it has both", () => {
    expect(signedInAvailability(true, true)).toBe("sign-in");
  });
});

describe("planSignedInGroups", () => {
  const files = [
    "_authenticated/account.tsx",
    "_authenticated/manager.index.tsx",
    "_authenticated/manager.users_.$userId.tsx",
  ];
  const fixture = {
    personas: { member: { email: "m@example.com" }, manager: { email: "p@example.com" } },
    params: { userId: "abc" },
  };

  it("splits the pages by who has to be signed in, parameters filled", () => {
    expect(planSignedInGroups(files, fixture)).toEqual([
      { persona: "member", email: "m@example.com", paths: ["/account"] },
      { persona: "manager", email: "p@example.com", paths: ["/manager", "/manager/users/abc"] },
    ]);
  });

  it("fails on a parameter the fixture cannot fill, rather than skipping the screen", () => {
    expect(() => planSignedInGroups(files, { ...fixture, params: {} })).toThrow(
      /no fixture value for .*\$userId/,
    );
  });

  it("fails when a persona has no pages, which means the derivation broke", () => {
    expect(() => planSignedInGroups(["_authenticated/manager.index.tsx"], fixture)).toThrow(
      /no member pages/,
    );
  });

  it("fails when the manifest names nobody to sign in as", () => {
    expect(() => planSignedInGroups(files, { ...fixture, personas: {} })).toThrow(
      /names no member/,
    );
  });
});
