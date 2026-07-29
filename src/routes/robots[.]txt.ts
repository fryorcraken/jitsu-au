// GET /robots.txt
//
// The filename escapes the dot (`robots[.]txt.ts`) because TanStack Router
// reads a bare `.` as a path separator: `robots.txt.ts` would serve
// /robots/txt. The rules themselves live in `src/lib/seo.ts`.
import { createFileRoute } from "@tanstack/react-router";
import { buildRobotsTxt } from "@/lib/seo";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(buildRobotsTxt(new URL(request.url).host), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }),
    },
  },
});
