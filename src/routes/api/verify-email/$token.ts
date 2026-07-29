// Email verification landing: GET /api/verify-email/<token>?next=<path>
//
// Opening this link is the proof. The token rides in the URL path because an
// email client cannot send an Authorization header, exactly like the per-person
// calendar feed at /api/calendar/<token>.
//
// The response is deliberately UNIFORM. A valid token, an expired one, one for
// an address that has since changed, and one that never existed all produce the
// same 302 to the same page. Anything else would make this endpoint a way to
// probe which addresses the club holds, and the visitor has nothing useful to do
// with the difference anyway.
//
// All DB access uses the service-role client, lazy-imported (route files ship to
// the client bundle, so it must never be a top-level import).
import { createFileRoute } from "@tanstack/react-router";
import { verifyRedirectPath } from "@/lib/email-verification";

export const Route = createFileRoute("/api/verify-email/$token")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const url = new URL(request.url);
        const next = verifyRedirectPath(url.searchParams.get("next"));
        const destination = new URL(next, url.origin).toString();
        const redirect = () => Response.redirect(destination, 302);

        const raw = params.token;
        if (!raw) return redirect();

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { redeemVerificationToken } = await import("@/lib/email-verification.server");
          const outcome = await redeemVerificationToken(supabaseAdmin, raw);
          // Worth a server-side line: "stale" means someone clicked a link for
          // an address the account no longer has, which is the signal that a
          // correction happened and the member is still using the old email.
          if (outcome.result === "stale") {
            console.warn(`[verify-email] stale token for ${outcome.email}; account has moved on`);
          }
        } catch (e) {
          // Verification failing must never strand somebody on an error page.
          console.error("[verify-email] redemption failed:", e);
        }

        return redirect();
      },
    },
  },
});
