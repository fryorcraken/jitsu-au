// Upload link for a blog image — where `start_blog_image_upload` sends an
// assistant to deliver a photo's bytes when it cannot type them out over MCP.
//
//   POST /api/manager/blog-image   Authorization: Bearer <ticket>, body = the image
//
// The ticket is the only credential this accepts, and storing one image is the
// only thing it can do: no manager token or sign-in works here, and a ticket
// works nowhere else. Why it exists, and what keeps it to one image within the
// hour: src/lib/blog-image-ticket.ts. The answer has the agent API's envelope.
import { createFileRoute } from "@tanstack/react-router";
import { AGENT_MANIFEST } from "@/lib/manager-agent";
import {
  errorResponse,
  json,
  methodNotAllowed,
  uploadBlogImageWithTicket,
} from "@/lib/manager-agent-actions";

export const Route = createFileRoute("/api/manager/blog-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const result = await uploadBlogImageWithTicket(request);
          // The version travels on every response here too, as on the agent
          // endpoint, so a client comparing it per call is not left guessing.
          return json({ ok: true, version: AGENT_MANIFEST.version, result });
        } catch (e) {
          return errorResponse(e);
        }
      },
      GET: async () => methodNotAllowed("POST"),
      PUT: async () => methodNotAllowed("POST"),
      PATCH: async () => methodNotAllowed("POST"),
      DELETE: async () => methodNotAllowed("POST"),
    },
  },
});
