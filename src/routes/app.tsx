import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AuthPending } from "@/components/site/AuthPending";
import { MEMBER_HOME_PATH, resolveLaunchTarget } from "@/lib/pwa";
import { readLastVisit } from "@/lib/last-visit";

/**
 * The installed app's launch screen (`start_url` in the web manifest).
 *
 * It renders nothing of its own: it works out who is holding the phone and
 * forwards them to the screen they actually wanted, so a member taps the icon
 * and lands in their member area instead of on the marketing home page.
 *
 * When the app was open recently it forwards them back to the screen they were
 * actually on, which is what makes a relaunch feel like a resume. The installed
 * app has no resume of its own: a phone reclaiming it in the background means
 * the next tap is a cold launch right here. `resolveLaunchTarget` owns the rule,
 * including which paths must never be reopened.
 *
 * `ssr: false` because the answer depends on the Supabase session, which lives
 * in the browser. Rendering it on the server would only produce a guess that
 * the client then has to correct, in front of the user.
 */
export const Route = createFileRoute("/app")({
  ssr: false,
  head: () => ({
    meta: [{ title: "UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  // Same reasoning as the member-area gate: hold off briefly so a warm launch
  // goes straight to content, then keep the spinner up long enough that it does
  // not read as a flicker.
  pendingMs: 100,
  pendingMinMs: 300,
  pendingComponent: () => <AuthPending label="Opening UTS Jitsu" />,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    const hasSession = Boolean(data.session);
    const target = resolveLaunchTarget({
      hasSession,
      lastVisit: readLastVisit(data.session?.user?.id ?? null),
      now: Date.now(),
    });

    // `replace` so the launch route never sits in the back stack: pressing back
    // from the member area should leave the app, not bounce through here.
    //
    // The recorded path goes through `href` rather than `to`: it is a string
    // read back off the device, not one of the router's known route ids, and
    // `resolveLaunchTarget` has already refused anything that is not a plain
    // site-relative path.
    if ("path" in target) throw redirect({ href: target.path, replace: true });
    if (target.screen === "member") throw redirect({ to: MEMBER_HOME_PATH, replace: true });
    throw redirect({ to: "/", replace: true });
  },
  component: () => <AuthPending label="Opening UTS Jitsu" />,
});
