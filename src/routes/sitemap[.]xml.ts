// GET /sitemap.xml
//
// Lists every publicly indexable page so search engines find the ones the home
// page does not link to directly: the fixed pages from `src/lib/seo.ts`, plus
// one entry per published blog post. The escaped dot in the filename keeps the
// route at /sitemap.xml (see `robots[.]txt.ts`).
import { createFileRoute } from "@tanstack/react-router";
import { PUBLIC_PAGES, blogPostSitemapPages, buildSitemapXml, type SitemapPage } from "@/lib/seo";

/**
 * The blog posts, or none if they cannot be read.
 *
 * Fails open on purpose: a sitemap without the posts still lists every fixed
 * page, while an error response would hide those too until the next crawl.
 * Lazy-imported so this route file never pulls the blog's server code into the
 * client bundle.
 */
async function blogPages(): Promise<SitemapPage[]> {
  try {
    const { listSitemapBlogPosts } = await import("@/lib/blog.functions");
    return blogPostSitemapPages(await listSitemapBlogPosts());
  } catch (error) {
    console.error("[sitemap] could not list blog posts; serving the fixed pages only", error);
    return [];
  }
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () =>
        new Response(buildSitemapXml([...PUBLIC_PAGES, ...(await blogPages())]), {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }),
    },
  },
});
