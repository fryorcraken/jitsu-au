// The daily notification digest: POST /api/notifications/digest
//
// Called on a schedule by .github/workflows/notification-digest.yml, which is
// the only scheduler this project has. There is no cron in the database (the
// Supabase project is Lovable-managed and pg_cron is not in this repo's
// migrations) and no Cloudflare cron (no wrangler.toml here, Lovable owns the
// deploy), so a GitHub Actions schedule calling this endpoint is the mechanism.
//
// Auth is a shared bearer token in NOTIFICATION_DIGEST_KEY, compared in constant
// time. An UNSET key refuses everything rather than running open: a digest
// endpoint anybody can POST to is a way to make the club email its own members
// on demand.
//
// All DB access uses the service-role client, lazy-imported (route files ship to
// the client bundle, so it must never be a top-level import).
import { createFileRoute } from "@tanstack/react-router";
import { bearerToken, safeEqual } from "@/lib/manager-agent";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const Route = createFileRoute("/api/notifications/digest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.NOTIFICATION_DIGEST_KEY;
        if (!expected) {
          // Deliberately 503 and not 401: nothing the caller can send would
          // work, and saying "unauthorized" would send somebody hunting for a
          // token that has not been configured.
          console.warn("[digest] NOTIFICATION_DIGEST_KEY is not set — refusing to run");
          return json({ error: "The digest is not configured." }, 503);
        }

        const token = bearerToken(request.headers.get("authorization"));
        if (!token || !safeEqual(token, expected)) {
          return json({ error: "Unauthorized." }, 401);
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { sendDailyDigests } = await import("@/lib/notification-email.server");
          const result = await sendDailyDigests(supabaseAdmin);
          // Echoed into the workflow log so a run that mailed nobody is
          // distinguishable from a run that never happened.
          console.log(
            `[digest] considered ${result.considered} notifications for ${result.recipients} people, sent ${result.sent}`,
          );
          return json({ ok: true, ...result }, 200);
        } catch (e) {
          const message = e instanceof Error ? e.message : "The digest failed.";
          console.error("[digest] run failed:", e);
          return json({ error: message }, 500);
        }
      },
    },
  },
});
