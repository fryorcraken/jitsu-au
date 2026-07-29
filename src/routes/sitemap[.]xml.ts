// GET /sitemap.xml
//
// Lists every publicly indexable page so search engines find the ones the home
// page does not link to directly. The escaped dot in the filename keeps the
// route at /sitemap.xml (see `robots[.]txt.ts`). Page list: `src/lib/seo.ts`.
import { createFileRoute } from "@tanstack/react-router";
import { buildSitemapXml } from "@/lib/seo";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(buildSitemapXml(), {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }),
    },
  },
});
