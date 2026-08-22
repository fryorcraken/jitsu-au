// The pages anyone can open, and the ones the sitemap lists.
//
// Split out of seo.ts so it can be imported by a test runner that is not the
// app's own bundler. seo.ts imports the club's logo and hero asset manifests;
// this file imports nothing at all, which is what lets the e2e tour
// (e2e/tour/site.spec.ts) walk every public page under Playwright's plain
// TypeScript loader. seo.ts re-exports everything here, so `@/lib/seo` remains
// the address the app imports from.

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
  { path: "/blog", changefreq: "weekly", priority: 0.7 },
  { path: "/calendar", changefreq: "daily", priority: 0.6 },
  { path: "/contact", changefreq: "yearly", priority: 0.5 },
  // Indexable on purpose. A club that publishes the rules it trains by is worth
  // finding, and the page is readable by anyone: the signing form only appears
  // for someone the site can already identify.
  { path: "/code-of-conduct", changefreq: "yearly", priority: 0.4 },
];

/**
 * Public pages that are deliberately absent from the sitemap.
 *
 * They are server-rendered `noindex` (see the robots rules in seo.ts), and
 * `seo.test.ts` FAILS if a noindex page appears in `PUBLIC_PAGES` — so unlike
 * the signed-in pages, these can never be derived from anything. A new public
 * noindex page has to be listed here or nothing ever looks at it.
 *
 * Not listed, because each needs a token or a session that only its own email
 * gives it: `/update-password`, `/blog/$slug`.
 *
 * `/email-settings` IS listed, even though the settings behind it need a
 * credential. Its URL no longer carries one (`/email-settings/<token>` sets a
 * cookie and redirects here), so it is a fixed address anybody can open, and
 * what it shows them without that cookie is a real screen worth photographing.
 */
export const PUBLIC_NOINDEX_PATHS = [
  "/waiver",
  "/auth",
  "/reset-password",
  "/thank-you",
  "/app",
  "/email-settings",
];
