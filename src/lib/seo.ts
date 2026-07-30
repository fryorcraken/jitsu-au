// Single source of truth for what search engines are told about this site.
//
// Four things live here because they have to agree with each other:
//   - the canonical origin every public page points at,
//   - the list of pages that belong in the sitemap,
//   - the crawl rules served at /robots.txt,
//   - the club's structured data (who we are, where we train).
//
// The routes that serve the first three (`src/routes/robots[.]txt.ts` and
// `src/routes/sitemap[.]xml.ts`) are thin wrappers around the builders below,
// so the rules stay unit-testable and free of any server import.

import { GOOGLE_MAPS_URL, VENUE_NAME } from "./venue";

/** Canonical origin. Every `rel="canonical"` on the site points here. */
export const SITE_ORIGIN = "https://jitsu.au";

/**
 * Hosts that serve the real site. Anything else (a Lovable preview, a
 * Cloudflare *.workers.dev URL, a branch deploy) is the same content on a
 * different hostname, which is exactly the duplicate-content case search
 * engines penalise. Those hosts get a "stay out" robots.txt instead.
 *
 * The club's other domains are listed here on purpose, and are NOT blocked.
 * They serve the same site, and every page canonicals to jitsu.au, so letting
 * crawlers in is what consolidates the ranking signal onto jitsu.au. Blocking
 * them would stop a crawler ever reading that canonical and leave bare,
 * contentless URLs eligible for the index instead.
 *
 * This list is the site's off switch: a host that is missing here is told to
 * stay out entirely. `www.` variants are included whether or not they are
 * wired up today, because listing a host that never receives a request costs
 * nothing, while omitting one that does costs the site its search traffic.
 */
export const PRODUCTION_HOSTS = [
  "jitsu.au",
  "www.jitsu.au",
  "utsjitsu.com.au",
  "www.utsjitsu.com.au",
  "sydneyjitsu.com.au",
  "www.sydneyjitsu.com.au",
];

/**
 * The image social platforms show when someone shares a link to the site.
 *
 * The root route already sets `twitter:card: summary_large_image`, which asks
 * for a picture; without one, a shared link renders as a bare grey box.
 */
export const SOCIAL_IMAGE = {
  url: `${SITE_ORIGIN}/logo.png`,
  width: 786,
  height: 491,
  alt: "UTS Jitsu",
} as const;

/**
 * Club contact details that appear in structured data.
 *
 * These mirror what the footer and the contact page render. `seo.test.ts` reads
 * those files and fails if the two ever drift apart.
 */
export const CLUB_PHONE_E164 = "+61493631759";
export const CLUB_SOCIAL_URLS = [
  "https://www.instagram.com/utsjitsu",
  "https://www.youtube.com/@sydneyjitsu",
] as const;

export type ChangeFrequency = "daily" | "weekly" | "monthly" | "yearly";

export type SitemapPage = {
  /** Root-relative path, exactly as it appears in the page's canonical link. */
  path: string;
  changefreq: ChangeFrequency;
  /** Relative importance within this site only (0.0 - 1.0). */
  priority: number;
};

/**
 * Every publicly indexable page, in the order they should be crawled.
 *
 * A page belongs here when it sets a `rel="canonical"` and does NOT set
 * `robots: noindex`. `seo.test.ts` reads the route files and enforces exactly
 * that, so a new marketing page cannot quietly miss the sitemap.
 */
export const PUBLIC_PAGES: SitemapPage[] = [
  { path: "/", changefreq: "weekly", priority: 1.0 },
  { path: "/classes", changefreq: "monthly", priority: 0.9 },
  { path: "/first-class", changefreq: "monthly", priority: 0.9 },
  { path: "/pricing", changefreq: "monthly", priority: 0.9 },
  { path: "/register-interest", changefreq: "monthly", priority: 0.9 },
  { path: "/about", changefreq: "monthly", priority: 0.7 },
  { path: "/instructors", changefreq: "monthly", priority: 0.7 },
  { path: "/faq", changefreq: "monthly", priority: 0.7 },
  { path: "/calendar", changefreq: "daily", priority: 0.6 },
  { path: "/contact", changefreq: "yearly", priority: 0.5 },
];

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
  "/lovable/",
  "/manager",
  "/membership",
] as const;

/** Absolute URL for a root-relative path, e.g. "/about" -> "https://jitsu.au/about". */
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
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

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

/** True when the request arrived on a hostname that serves the real site. */
export function isProductionHost(host: string | null | undefined): boolean {
  if (!host) return false;
  // A Host header may carry a port; the rules do not depend on it.
  const name = host.trim().toLowerCase().split(":")[0];
  return PRODUCTION_HOSTS.includes(name);
}

/**
 * robots.txt body for the host the request came in on.
 *
 * Production gets the real rules plus the sitemap pointer. Every other host
 * gets a blanket disallow, so preview deploys never compete with jitsu.au in
 * search results.
 */
export function buildRobotsTxt(host: string | null | undefined): string {
  if (!isProductionHost(host)) {
    return [
      "# Not the canonical UTS Jitsu site (preview or branch deploy).",
      "# The real site is https://jitsu.au",
      "User-agent: *",
      "Disallow: /",
      "",
    ].join("\n");
  }

  return [
    "# UTS Jitsu (https://jitsu.au)",
    "User-agent: *",
    "Allow: /",
    ...CRAWLER_DISALLOW.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * Structured data describing the club, emitted once on the home page.
 *
 * This is what lets a search engine understand that jitsu.au is a martial arts
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
    logo: SOCIAL_IMAGE.url,
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
    address: {
      "@type": "PostalAddress",
      streetAddress: "Harris Street",
      addressLocality: "Ultimo",
      addressRegion: "NSW",
      postalCode: "2007",
      addressCountry: "AU",
    },
    location: {
      "@type": "Place",
      name: VENUE_NAME,
      address: {
        "@type": "PostalAddress",
        streetAddress: "Harris Street",
        addressLocality: "Ultimo",
        addressRegion: "NSW",
        postalCode: "2007",
        addressCountry: "AU",
      },
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
