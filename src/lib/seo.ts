// Single source of truth for what search engines are told about this site.
//
// Four things live here because they have to agree with each other:
//   - the canonical URL every public page points at (built on SITE_ORIGIN,
//     which lives in `site-origin.ts`),
//   - the list of pages that belong in the sitemap,
//   - the crawl rules served at /robots.txt,
//   - the club's structured data (who we are, where we train).
//
// The routes that serve the first three (`src/routes/robots[.]txt.ts` and
// `src/routes/sitemap[.]xml.ts`) are thin wrappers around the builders below,
// so the rules stay unit-testable and free of any server import.

import { PUBLIC_PAGES, type SitemapPage } from "./public-pages";
import {
  GOOGLE_MAPS_URL,
  VENUE_NAME,
  VENUE_PHONE_E164,
  VENUE_POSTCODE,
  VENUE_STATE,
  VENUE_STREET_ADDRESS,
  VENUE_SUBURB,
} from "./venue";
import { SITE_ORIGIN, isProductionHost } from "./site-origin";
import trainingAsset from "../assets/training1.jpg.asset.json";
import logoAsset from "../assets/UTS_JITSU_CMYK.png.asset.json";

/**
 * The image social platforms show when someone shares a link to the site.
 *
 * The root route already sets `twitter:card: summary_large_image`, which asks
 * for a picture; without one, a shared link renders as a bare grey box.
 *
 * This is the same training photo used as the homepage hero
 * (`src/assets/training1.jpg.asset.json`, imported above), served from
 * Lovable's asset host rather than `public/`. Width/height match the
 * intrinsic size set on that `<img>` in `routes/index.tsx`.
 */
export const SOCIAL_IMAGE = {
  url: `${SITE_ORIGIN}${trainingAsset.url}`,
  width: 1600,
  height: 1205,
  alt: "UTS Jitsu students training on the mat",
} as const;

/**
 * The club's actual brand mark (the same file `SiteHeader` renders), as
 * opposed to `SOCIAL_IMAGE` above. Structured data's `logo` field is read by
 * Google for the Knowledge Panel and is expected to be a brand mark, not an
 * arbitrary photo, so `buildClubJsonLd` uses this instead of `SOCIAL_IMAGE`.
 */
export const CLUB_LOGO_URL = `${SITE_ORIGIN}${logoAsset.url}`;

/**
 * Club contact details that appear in structured data.
 *
 * The phone is not restated here: it is the same `venue.ts` constant the footer
 * and the contact page render, so structured data cannot drift from the visible
 * number. `seo.test.ts` pins that the pages really do read it from there.
 */
export const CLUB_PHONE_E164 = VENUE_PHONE_E164;
export const CLUB_SOCIAL_URLS = [
  "https://www.instagram.com/utsjitsu",
  "https://www.youtube.com/@sydneyjitsu",
] as const;

export type { ChangeFrequency, SitemapPage } from "./public-pages";
export { PUBLIC_PAGES } from "./public-pages";

/**
 * Paths crawlers should not spend their budget on.
 *
 * Deliberately short. Public pages that must not be indexed (`/waiver`,
 * `/thank-you`, the auth screens) are server-rendered with `robots: noindex`,
 * and a crawler has to be allowed to fetch a page to see that tag. Blocking
 * them here instead would leave the URL eligible for a bare, contentless
 * listing. What is listed below is either not a page at all (`/api/`,
 * `/lovable/`) or sits behind the auth gate, which renders client-side only,
 * so its `noindex` never reaches a crawler in the first place.
 */
export const CRAWLER_DISALLOW = [
  "/account",
  "/api/",
  // The knowledge base is signed-in only and renders client-side, so its
  // `noindex` never reaches a crawler: exactly the case this list is for.
  "/kb",
  "/lovable/",
  "/manager",
  "/membership",
] as const;

/** Absolute URL for a root-relative path, e.g. "/about" -> "https://utsjitsu.com.au/about". */
export function canonicalUrl(path: string): string {
  return path === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`;
}

export type PageMetaOptions = {
  /** <title> and search-result title. */
  title: string;
  /** <meta name="description">. */
  description: string;
  /** og:title / twitter:title. Defaults to `title`. */
  ogTitle?: string;
  /** og:description / twitter:description. Defaults to `description`. */
  ogDescription?: string;
  /** Root-relative path this page is served at, used to build og:url. */
  path: string;
};

/** The meta tag shapes `buildPageMeta` produces (a route's `head().meta` array element). */
export type PageMetaTag =
  { title: string } | { name: string; content: string } | { property: string; content: string };

/**
 * A page's title/description/OpenGraph/Twitter meta, keyed so the router
 * replaces the root route's generic versions instead of leaving them next to
 * a page-specific one. The root only sets `og:*`/`twitter:*` as a shared
 * fallback; a page that overrode `og:title` but not `twitter:title` still
 * showed the home page's title on Twitter/Slack/iMessage previews, since
 * they're unrelated attributes as far as the head merge is concerned. Every
 * page should build its social tags through this helper so the two stay in
 * sync.
 */
export function buildPageMeta({
  title,
  description,
  ogTitle = title,
  ogDescription = description,
  path,
}: PageMetaOptions): PageMetaTag[] {
  const url = canonicalUrl(path);
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: ogTitle },
    { property: "og:description", content: ogDescription },
    { property: "og:url", content: url },
    { name: "twitter:title", content: ogTitle },
    { name: "twitter:description", content: ogDescription },
  ];
}

/** Roughly how much of a title a search result shows before cutting it off. */
export const BLOG_SEO_TITLE_SHOWN = 60;
/** Roughly how much of a description a search result shows. */
export const BLOG_SEO_DESCRIPTION_SHOWN = 155;

/** What a post's page says when it has neither a search description nor an excerpt. */
export const BLOG_DEFAULT_DESCRIPTION = "News, tips and updates from UTS Jitsu.";

/**
 * The title and description a post's page gives search engines and link
 * previews: the manager's own when they set one, otherwise the defaults every
 * post had before those fields existed (the post title with the blog's name,
 * and the excerpt). Resolved at read time rather than stored, so a post left on
 * the defaults follows a later edit to its title or excerpt by itself.
 *
 * The public page and the editor's search preview both call this, so what the
 * manager is shown is what gets served.
 */
export function blogPostSeo(post: {
  title: string;
  excerpt: string | null;
  seo_title: string | null;
  seo_description: string | null;
}): { title: string; description: string } {
  return {
    title: post.seo_title?.trim() || `${post.title} | UTS Jitsu Blog`,
    description: post.seo_description?.trim() || post.excerpt?.trim() || BLOG_DEFAULT_DESCRIPTION,
  };
}

/**
 * robots.txt body for the host the request came in on.
 *
 * Production gets the real rules plus the sitemap pointer. Every other host
 * gets a blanket disallow, so preview deploys never compete with the real site in
 * search results.
 */
export function buildRobotsTxt(host: string | null | undefined): string {
  if (!isProductionHost(host)) {
    return [
      "# Not the canonical UTS Jitsu site (preview or branch deploy).",
      `# The real site is ${SITE_ORIGIN}`,
      "User-agent: *",
      "Disallow: /",
      "",
    ].join("\n");
  }

  return [
    `# UTS Jitsu (${SITE_ORIGIN})`,
    "User-agent: *",
    "Allow: /",
    ...CRAWLER_DISALLOW.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * The club's postal address, built from the parts in `venue.ts` so the schema
 * cannot say one thing while the pages say another. `streetAddress` carries the
 * street number: a bare street name is not an address a search engine can place
 * on a map, and Harris Street is nearly two kilometres long.
 */
function postalAddress(): Record<string, string> {
  return {
    "@type": "PostalAddress",
    streetAddress: VENUE_STREET_ADDRESS,
    addressLocality: VENUE_SUBURB,
    addressRegion: VENUE_STATE,
    postalCode: VENUE_POSTCODE,
    addressCountry: "AU",
  };
}

/**
 * Structured data describing the club, emitted once on the home page.
 *
 * This is what lets a search engine understand that this site is a martial arts
 * club that trains at a specific Sydney address, rather than a page that
 * happens to mention Ultimo. It carries only facts the site already states in
 * its own copy: name, address, phone and social profiles.
 *
 * Class times are deliberately left out. They live on the classes page and
 * change from time to time, and structured data that contradicts the page is
 * worse than none at all.
 */
export function buildClubJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    // Four types on purpose. `SportsClub` is the place you train at, and it is
    // what carries `address`. `sport` belongs to `SportsOrganization`, which
    // `SportsClub` does not inherit from, so a validator reports it as an
    // unknown property unless the club is declared as both.
    //
    // `SportsClub` -> `SportsActivityLocation` -> `LocalBusiness` already makes
    // this a `LocalBusiness` (and, via `LocalBusiness` -> `Organization`, an
    // `Organization` too) by schema.org's own class hierarchy, so these last two
    // are redundant to a spec-following validator. They are listed explicitly
    // anyway because the tools that actually drive rich results and local-search
    // eligibility (Google's Rich Results Test among them) key off literal
    // `@type` strings rather than walking the ontology, and `SportsClub` /
    // `SportsOrganization` alone are too obscure for most of them to recognise.
    "@type": ["SportsClub", "SportsOrganization", "LocalBusiness", "Organization"],
    "@id": `${SITE_ORIGIN}/#club`,
    name: "UTS Jitsu",
    description:
      "Japanese Jiu-Jitsu club training at UTS Ultimo in Sydney. Beginner-friendly classes in practical self-defence, with the first two sessions free.",
    url: `${SITE_ORIGIN}/`,
    logo: CLUB_LOGO_URL,
    image: SOCIAL_IMAGE.url,
    telephone: CLUB_PHONE_E164,
    sport: "Japanese Jiu-Jitsu",
    // Instructors page lists Franck Royer as "Lead instructor & founder" at
    // UTS Jitsu, Harris St. `foundingDate` is left out on purpose: the same
    // page shows both an original ~2017 founding and a 2026 "reopened as
    // head instructor" entry, so which one counts is a real ambiguity, not
    // something to infer.
    founder: { "@type": "Person", name: "Franck Royer" },
    areaServed: { "@type": "City", name: "Sydney" },
    hasMap: GOOGLE_MAPS_URL,
    address: postalAddress(),
    location: {
      "@type": "Place",
      name: VENUE_NAME,
      address: postalAddress(),
    },
    sameAs: [...CLUB_SOCIAL_URLS],
  };
}

/** Escape the five XML entities. Paths are ours, but a sitemap must be well-formed. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * sitemap.xml for the public pages.
 *
 * No `<lastmod>`: we have no trustworthy per-page modification date at request
 * time, and search engines discount a sitemap whose dates are all "now" more
 * than one that simply omits them.
 */
export function buildSitemapXml(pages: SitemapPage[] = PUBLIC_PAGES): string {
  const urls = pages.map((page) =>
    [
      "  <url>",
      `    <loc>${escapeXml(canonicalUrl(page.path))}</loc>`,
      `    <changefreq>${page.changefreq}</changefreq>`,
      `    <priority>${page.priority.toFixed(1)}</priority>`,
      "  </url>",
    ].join("\n"),
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
