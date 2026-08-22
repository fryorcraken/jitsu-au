// The settings link at the foot of every notification email:
// GET /email-settings/<token>
//
// This is not a page. It is an EXCHANGE: it puts the token in a short-lived
// cookie and sends the browser to /email-settings, which is where the switches
// actually live. By the time anybody is looking at the screen, the token is out
// of the address bar, out of the back button, and out of anything they paste.
//
// Why the token is in the path at all: a mail client cannot send an
// Authorization header or a POST body, the same constraint that puts one in
// /api/calendar/<token> and /api/verify-email/<token>. Those two keep the token
// on screen because there is nowhere else for it to go (a calendar app
// subscribes to a URL) or because it is single use and dead within the hour.
// This one is neither, so it is worth the redirect.
//
// The response is deliberately UNIFORM. A token that never existed, one that has
// been rotated, and a malformed one all redirect to the same page, and that page
// says the same thing for all of them. Answering differently would make this
// endpoint a way to probe which links the club has issued. Nothing here touches
// the database, so a stream of guesses costs a redirect and nothing else.
import { createFileRoute } from "@tanstack/react-router";

import {
  EMAIL_SETTINGS_PATH,
  buildEmailSettingsCookie,
  clearedEmailSettingsCookie,
} from "@/lib/email-settings-session";

export const Route = createFileRoute("/email-settings/$token")({
  server: {
    handlers: {
      GET: ({ params, request }) => {
        const url = new URL(request.url);
        // No Secure attribute over plain http, or the browser drops the cookie
        // and the local dev server and the e2e stack could never open the page.
        const secure = url.protocol === "https:";
        // A token we will not carry clears whatever was there rather than
        // leaving it: a broken link must never land somebody on the settings of
        // whoever used this browser before them.
        const cookie =
          buildEmailSettingsCookie(params.token ?? "", { secure }) ??
          clearedEmailSettingsCookie({ secure });

        return new Response(null, {
          status: 303,
          headers: {
            location: new URL(EMAIL_SETTINGS_PATH, url.origin).toString(),
            "set-cookie": cookie,
            // Also set by the security-headers middleware for this prefix. Said
            // here as well because a cached redirect would hand one person's
            // Set-Cookie to the next, which is the one caching mistake this
            // route cannot survive.
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
