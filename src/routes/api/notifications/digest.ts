// The daily notification digest: POST /api/notifications/digest
//
// Called on a schedule by pg_cron in the database, which reads a bearer token
// out of Supabase Vault and POSTs here with pg_net. See
// supabase/migrations/20260822000000_notification_digest_key_single_source.sql.
//
// This used to be a GitHub Actions workflow. It was moved because scheduling
// production work from CI put a credential that makes the site email its members
// in a repo that takes same-repo branches from Lovable and from coding agents,
// and made the club's schedule depend on GitHub not disabling it.
//
// Auth is a shared bearer token, compared in constant time, and it has exactly
// ONE home: Supabase Vault. This endpoint reads it through the same
// service-role RPC the migration's own function reads, instead of a server env
// var that had to be typed in twice and matched forever. That second copy was
// the actual defect: the club owner could not find the screen to set it, so it
// was never set, and the digest went five nights "succeeding" at doing nothing.
// See docs/notifications.md.
//
// A missing Vault secret still refuses everything rather than running open: a
// digest endpoint anybody can POST to is a way to make the club email its own
// members on demand. The scheduled job fails closed the same way when its
// Vault secret is missing, so both halves read from the one place there is
// now to configure.
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

// Cached in module scope after the first successful read, so an ordinary night
// of digest traffic costs one Vault round trip rather than one per request.
// Rotating the secret needs a redeploy to pick the new value up here, which is
// the same story every other env-var-shaped config in this app already has.
let cachedKey: string | null = null;

/**
 * Read the digest's bearer token from Vault, but only when a request actually
 * carries one to check it against — an unauthenticated flood (or a scanner
 * hitting every route on the site) must not be a way to turn HTTP traffic into
 * database load.
 */
async function expectedKey(): Promise<string | null> {
  if (cachedKey) return cachedKey;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { notificationDigestKey } = await import("@/lib/supabase-rpc");
  const { data, error } = await notificationDigestKey(supabaseAdmin);
  if (error) {
    console.error("[digest] failed to read notification_digest_key from Vault:", error.message);
    return null;
  }
  if (data) cachedKey = data;
  return data;
}

export const Route = createFileRoute("/api/notifications/digest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = bearerToken(request.headers.get("authorization"));
        if (!token) {
          return json({ error: "Unauthorized." }, 401);
        }

        const expected = await expectedKey();
        if (!expected) {
          // Deliberately 503 and not 401: nothing the caller can send would
          // work, and saying "unauthorized" would send somebody hunting for a
          // token that has not been configured.
          console.warn("[digest] notification_digest_key not set in Vault — refusing to run");
          return json({ error: "The digest is not configured." }, 503);
        }

        if (!safeEqual(token, expected)) {
          return json({ error: "Unauthorized." }, 401);
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { sendDailyDigests } = await import("@/lib/notification-email.server");
          const result = await sendDailyDigests(supabaseAdmin);
          // The only durable record that a run happened. The caller is pg_net,
          // which discards the response, so a run that mailed nobody is
          // distinguishable from a run that never happened ONLY here, in the
          // deploy log. See docs/notifications.md on the digest's observability.
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
