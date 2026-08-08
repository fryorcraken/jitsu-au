import { describe, expect, it } from "vitest";

import {
  fillRouteParams,
  personaFor,
  routeFileToPath,
  signedInPaths,
} from "./pr-screenshots-pages.mjs";

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
