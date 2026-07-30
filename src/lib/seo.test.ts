import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SITE_ORIGIN,
  PUBLIC_PAGES,
  CRAWLER_DISALLOW,
  CLUB_PHONE_E164,
  CLUB_SOCIAL_URLS,
  SOCIAL_IMAGE,
  buildClubJsonLd,
  buildPageMeta,
  buildRobotsTxt,
  buildSitemapXml,
  canonicalUrl,
  isProductionHost,
} from "./seo";
import { Route as RootRoute } from "@/routes/__root";
import { Route as AboutRoute } from "@/routes/about";

describe("canonicalUrl", () => {
  it("keeps the trailing slash on the home page", () => {
    expect(canonicalUrl("/")).toBe("https://jitsu.au/");
  });

  it("appends other paths to the origin without a trailing slash", () => {
    expect(canonicalUrl("/about")).toBe("https://jitsu.au/about");
  });
});

type MetaEntry = ReturnType<typeof buildPageMeta>[number];

/** Reads a meta entry's `content` by its `name` or `property` key. */
function metaContent(meta: MetaEntry[], key: string): unknown {
  for (const m of meta) {
    const record = m as Record<string, unknown>;
    if (record.name === key || record.property === key) return record.content;
  }
  return undefined;
}

describe("buildPageMeta", () => {
  // The bug this guards against: the root route sets generic og:*/twitter:*
  // tags as a fallback, and the router only replaces a tag whose own
  // name/property is repeated by a child. A page that overrode og:title but
  // not twitter:title kept the home page's title in Twitter/Slack/iMessage
  // previews, on every route that didn't happen to also set twitter:title.
  it("mirrors og:title/og:description onto twitter:title/twitter:description", () => {
    const meta = buildPageMeta({
      title: "Page Title",
      description: "Page description.",
      ogTitle: "Social title",
      ogDescription: "Social description.",
      path: "/page",
    });
    expect(metaContent(meta, "twitter:title")).toBe("Social title");
    expect(metaContent(meta, "twitter:description")).toBe("Social description.");
    expect(metaContent(meta, "og:title")).toBe("Social title");
    expect(metaContent(meta, "og:description")).toBe("Social description.");
  });

  it("falls og:title/og:description/twitter:* back to title/description when unset", () => {
    const meta = buildPageMeta({
      title: "Page Title",
      description: "Page description.",
      path: "/page",
    });
    for (const key of ["og:title", "twitter:title"]) {
      expect(metaContent(meta, key)).toBe("Page Title");
    }
    for (const key of ["og:description", "twitter:description"]) {
      expect(metaContent(meta, key)).toBe("Page description.");
    }
  });

  it("builds an absolute og:url from the given path", () => {
    const meta = buildPageMeta({ title: "T", description: "D", path: "/about" });
    expect(metaContent(meta, "og:url")).toBe("https://jitsu.au/about");
  });

  it("sets the <title> tag", () => {
    const meta = buildPageMeta({ title: "Page Title", description: "D", path: "/" });
    expect(meta.find((m) => "title" in m)).toMatchObject({ title: "Page Title" });
  });
});

/**
 * Mirrors the merge in `@tanstack/react-router`'s head-tag builder
 * (`headContentUtils.cjs`: `buildTagsFromMatches`/`useTags`): matches are
 * walked leaf-first, and a tag is dropped once its `name`/`property` has
 * already been emitted by a more leaf-specific match.
 */
function mergeRouteMeta(matchMetaArrays: Record<string, unknown>[][]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (let i = matchMetaArrays.length - 1; i >= 0; i--) {
    for (const tag of matchMetaArrays[i]) {
      const key =
        typeof tag.name === "string"
          ? tag.name
          : typeof tag.property === "string"
            ? tag.property
            : undefined;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(tag);
    }
  }
  return merged;
}

// This exercises the real root and page `head()` functions (not just
// `buildPageMeta`'s own output), through a reimplementation of the router's
// actual merge algorithm, so it fails the way the original bug did: before
// the fix, /about didn't declare twitter:title, and this would have resolved
// to the root's generic "UTS Jitsu | Practical Japanese Jiu-Jitsu in Sydney"
// instead of the page's own "About UTS Jitsu".
describe("root + page head merge (regression guard for the Twitter Card bug)", () => {
  it("resolves /about's merged twitter:title/description to its own tags, not the root's fallback", () => {
    const rootMeta = (RootRoute.options.head as () => { meta: Record<string, unknown>[] })().meta;
    const aboutMeta = (AboutRoute.options.head as () => { meta: Record<string, unknown>[] })().meta;
    const merged = mergeRouteMeta([rootMeta, aboutMeta]);
    const contentFor = (key: string) =>
      merged.find((m) => m.name === key || m.property === key)?.content;

    expect(contentFor("og:title")).toBe("About UTS Jitsu");
    expect(contentFor("twitter:title")).toBe("About UTS Jitsu");
    expect(contentFor("og:description")).toBe(
      "Practical Japanese Jiu-Jitsu, inclusive community, and 25+ years of martial arts experience.",
    );
    expect(contentFor("twitter:description")).toBe(
      "Practical Japanese Jiu-Jitsu, inclusive community, and 25+ years of martial arts experience.",
    );
    // No page overrides twitter:card, so the root's shared default survives the merge.
    expect(contentFor("twitter:card")).toBe("summary_large_image");
  });
});

describe("isProductionHost", () => {
  it("accepts the apex and www hosts", () => {
    expect(isProductionHost("jitsu.au")).toBe(true);
    expect(isProductionHost("www.jitsu.au")).toBe(true);
  });

  // These serve the same site. Missing one here would tell crawlers to drop it
  // from the index entirely, so each is pinned by name.
  it("accepts the club's other domains, apex and www alike", () => {
    for (const host of [
      "utsjitsu.com.au",
      "www.utsjitsu.com.au",
      "sydneyjitsu.com.au",
      "www.sydneyjitsu.com.au",
    ]) {
      expect(isProductionHost(host), `${host} would be told to stay out`).toBe(true);
    }
  });

  it("serves the real rules, not a blanket disallow, on the other domains", () => {
    const robots = buildRobotsTxt("utsjitsu.com.au");
    expect(robots).toContain("Allow: /");
    // The sitemap pointer stays absolute so every domain funnels crawlers to
    // the canonical one.
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  it("ignores case and a port", () => {
    expect(isProductionHost("JITSU.AU:443")).toBe(true);
  });

  it("rejects preview hosts, look-alikes and a missing host", () => {
    expect(isProductionHost("preview--utsjitsu.lovable.app")).toBe(false);
    expect(isProductionHost("localhost:5173")).toBe(false);
    // A suffix match would wrongly accept this one.
    expect(isProductionHost("jitsu.au.example.com")).toBe(false);
    expect(isProductionHost(null)).toBe(false);
    expect(isProductionHost("")).toBe(false);
  });
});

describe("buildRobotsTxt", () => {
  const robots = buildRobotsTxt("jitsu.au");

  it("allows crawling and points at the sitemap", () => {
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  it("disallows every private area", () => {
    for (const path of CRAWLER_DISALLOW) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
  });

  it("never blocks a page that is in the sitemap", () => {
    for (const page of PUBLIC_PAGES) {
      for (const blocked of CRAWLER_DISALLOW) {
        expect(page.path.startsWith(blocked)).toBe(false);
      }
    }
  });

  it("never blocks the noindex pages, which must be crawled to be seen as noindex", () => {
    for (const path of ["/waiver", "/thank-you", "/auth", "/reset-password", "/update-password"]) {
      expect(robots).not.toContain(`Disallow: ${path}`);
    }
  });

  it("keeps preview deploys out of search results entirely", () => {
    const preview = buildRobotsTxt("preview--utsjitsu.lovable.app");
    expect(preview).toContain("Disallow: /");
    expect(preview).not.toContain("Allow: /");
    // A preview must not advertise the production sitemap either.
    expect(preview).not.toContain("Sitemap:");
  });

  it("ends with a newline", () => {
    expect(robots.endsWith("\n")).toBe(true);
  });
});

describe("buildSitemapXml", () => {
  const xml = buildSitemapXml();

  it("declares the sitemap namespace", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("emits one absolute <loc> per public page", () => {
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PUBLIC_PAGES.map((p) => canonicalUrl(p.path)));
    for (const loc of locs) expect(loc.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
  });

  it("lists no page twice", () => {
    const paths = PUBLIC_PAGES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("writes priorities in the 0.0 - 1.0 range", () => {
    const priorities = [...xml.matchAll(/<priority>([^<]+)<\/priority>/g)].map((m) => Number(m[1]));
    expect(priorities).toHaveLength(PUBLIC_PAGES.length);
    for (const p of priorities) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("escapes XML-significant characters in a path", () => {
    const xmlWithEntities = buildSitemapXml([
      { path: "/search?q=gi&size=a2", changefreq: "monthly", priority: 0.5 },
    ]);
    expect(xmlWithEntities).toContain("<loc>https://jitsu.au/search?q=gi&amp;size=a2</loc>");
    expect(xmlWithEntities).not.toContain("&size");
  });
});

describe("SOCIAL_IMAGE", () => {
  it("is an absolute URL, which is the only form the social crawlers accept", () => {
    expect(SOCIAL_IMAGE.url).toBe(`${SITE_ORIGIN}/logo.png`);
  });

  it("is big enough for a large summary card", () => {
    // Twitter's floor for summary_large_image is 300x157.
    expect(SOCIAL_IMAGE.width).toBeGreaterThanOrEqual(300);
    expect(SOCIAL_IMAGE.height).toBeGreaterThanOrEqual(157);
  });

  it("is served from the public directory, so the file actually exists", () => {
    const file = join(import.meta.dirname, "..", "..", "public", "logo.png");
    expect(() => readFileSync(file)).not.toThrow();
  });
});

describe("buildClubJsonLd", () => {
  const club = buildClubJsonLd() as Record<string, unknown>;

  it("declares a sports club at the canonical URL", () => {
    expect(club["@context"]).toBe("https://schema.org");
    expect(club.url).toBe(`${SITE_ORIGIN}/`);
    expect(club.name).toBe("UTS Jitsu");
  });

  it("is typed as both a club and a sports organisation", () => {
    // `address` needs SportsClub; `sport` needs SportsOrganization, which
    // SportsClub does not inherit. Dropping either type makes one of them an
    // unknown property to a validator.
    expect(club["@type"]).toEqual(["SportsClub", "SportsOrganization"]);
    expect(club.sport).toBe("Japanese Jiu-Jitsu");
  });

  it("carries a postal address a search engine can place on a map", () => {
    const address = club.address as Record<string, string>;
    expect(address.addressLocality).toBe("Ultimo");
    expect(address.addressRegion).toBe("NSW");
    expect(address.postalCode).toBe("2007");
    expect(address.addressCountry).toBe("AU");
  });

  it("serialises to valid JSON for the ld+json script tag", () => {
    expect(() => JSON.parse(JSON.stringify(club))).not.toThrow();
  });

  it("uses absolute URLs for the logo and image", () => {
    expect(String(club.logo).startsWith(SITE_ORIGIN)).toBe(true);
    expect(String(club.image).startsWith(SITE_ORIGIN)).toBe(true);
  });
});

// Structured data that contradicts the visible page is worse than none, so the
// contact details are checked against what the site actually renders.
describe("club details match the site", () => {
  const srcDir = join(import.meta.dirname, "..");
  const footer = readFileSync(join(srcDir, "components", "site", "SiteFooter.tsx"), "utf8");
  const contact = readFileSync(join(srcDir, "routes", "contact.tsx"), "utf8");

  it("uses the phone number the footer and contact page dial", () => {
    // "+61493631759" -> the local "0493631759" both pages link with tel:.
    const local = CLUB_PHONE_E164.replace(/^\+61/, "0");
    expect(footer).toContain(`tel:${local}`);
    expect(contact).toContain(`tel:${local}`);
  });

  it("lists the social profiles the footer links to", () => {
    for (const url of CLUB_SOCIAL_URLS) {
      expect(footer).toContain(url);
    }
  });
});

// The sitemap is only useful if it keeps matching the site. These read the
// route files directly so adding a public page without listing it (or leaving a
// noindex page listed) fails here rather than silently costing search traffic.
/** URL a route file serves, from its directory prefix and basename-without-extension. */
function routePath(prefix: string, base: string): string {
  // "index" resolves to whatever its directory is, and a dot inside a route
  // filename is a path separator ("manager.waivers" -> "/manager/waivers").
  if (base === "index") return prefix || "/";
  return `${prefix}/${base.replace(/\./g, "/")}`;
}

/**
 * Every `.tsx` route file under `dir`, walked recursively.
 *
 * The walk has to descend: a page filed under a subdirectory later (a blog,
 * say) would otherwise slip past the sitemap check silently, which is the one
 * thing this suite exists to prevent.
 */
function collectRouteFiles(dir: string, prefix = ""): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `__root.tsx` is the app shell and `_`-prefixed names are layout or
    // pathless routes (`_authenticated`). Neither is an indexable page.
    if (entry.name.startsWith("_")) continue;
    if (entry.isDirectory()) {
      found.push(...collectRouteFiles(join(dir, entry.name), `${prefix}/${entry.name}`));
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    found.push({
      path: routePath(prefix, entry.name.replace(/\.tsx$/, "")),
      source: readFileSync(join(dir, entry.name), "utf8"),
    });
  }
  return found;
}

describe("routePath", () => {
  it("maps a top-level file to its own path", () => {
    expect(routePath("", "first-class")).toBe("/first-class");
  });

  it("maps index files to their directory", () => {
    expect(routePath("", "index")).toBe("/");
    expect(routePath("/blog", "index")).toBe("/blog");
  });

  it("nests a file under its directory", () => {
    expect(routePath("/blog", "my-first-class")).toBe("/blog/my-first-class");
  });

  it("reads a dot in the filename as a path separator", () => {
    expect(routePath("", "manager.waivers")).toBe("/manager/waivers");
  });
});

describe("sitemap coverage of the route files", () => {
  const routesDir = join(import.meta.dirname, "..", "routes");
  const routeFiles = collectRouteFiles(routesDir);

  /** Route files that render a page with its own canonical. */
  const canonicalRoutes = routeFiles
    .filter(({ source }) => source.includes('rel: "canonical"'))
    .map(({ path, source }) => ({
      path,
      noindex: /name: "robots", content: "noindex"/.test(source),
    }));

  it("finds the route files (guards against the scan itself breaking)", () => {
    expect(canonicalRoutes.length).toBeGreaterThan(5);
  });

  it("descends into subdirectories rather than only reading the top level", () => {
    // Nothing public lives in a subdirectory today, so prove the walk reaches
    // one: the auth-gated pages are the deepest .tsx files in the tree.
    const nested = collectRouteFiles(routesDir, "").length;
    const topLevelOnly = readdirSync(routesDir).filter((n) => n.endsWith(".tsx")).length;
    const authenticated = collectRouteFiles(join(routesDir, "_authenticated"), "/x");
    expect(authenticated.length).toBeGreaterThan(5);
    // The top level is all there is right now, minus `__root.tsx`, which the
    // walk skips. If that stops being true the walk must have found more.
    expect(nested).toBeGreaterThanOrEqual(topLevelOnly - 1);
  });

  it("lists every indexable route and no noindex one", () => {
    const expected = canonicalRoutes
      .filter((r) => !r.noindex)
      .map((r) => r.path)
      .sort();
    expect(PUBLIC_PAGES.map((p) => p.path).sort()).toEqual(expected);
  });

  it("matches each page's own canonical link", () => {
    for (const page of PUBLIC_PAGES) {
      const file = routeFiles.find((r) => r.path === page.path);
      expect(file, `no route file serves ${page.path}`).toBeDefined();
      expect(file!.source).toContain(`rel: "canonical", href: "${canonicalUrl(page.path)}"`);
    }
  });

  // The root route's <link>s are appended to every page's, not replaced by
  // them, so a canonical there put a second, competing one on every subpage.
  it("keeps the canonical off the root route, so no page ships two", () => {
    const root = readFileSync(join(routesDir, "__root.tsx"), "utf8");
    expect(root).not.toContain('rel: "canonical"');
  });
});
