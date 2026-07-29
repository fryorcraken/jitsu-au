import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AuthPending } from "@/components/site/AuthPending";
import { MEMBER_HOME_PATH, resolveLaunchScreen } from "@/lib/pwa";

/**
 * The installed app's launch screen (`start_url` in the web manifest).
 *
 * It renders nothing of its own: it works out who is holding the phone and
 * forwards them to the screen they actually wanted, so a member taps the icon
 * and lands in their member area instead of on the marketing home page.
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
    const screen = resolveLaunchScreen({ hasSession: Boolean(data.session) });

    // `replace` so the launch route never sits in the back stack: pressing back
    // from the member area should leave the app, not bounce through here.
    if (screen === "member") throw redirect({ to: MEMBER_HOME_PATH, replace: true });
    throw redirect({ to: "/", replace: true });
  },
  component: () => <AuthPending label="Opening UTS Jitsu" />,
});
