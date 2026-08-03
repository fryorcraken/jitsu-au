// The layout route for the whole knowledge base, and its sign-in gate.
//
// Everything under `/kb` renders inside `KbLayout` instead of `SiteLayout`, so
// the section has its own top bar, sidebar and footer. Its children must NOT
// wrap themselves in `SiteLayout` the way every other public route does — that
// would put the marketing chrome back on top of this one.
//
// SIGNED-IN ONLY, like `_authenticated`, and reached from the member area. What
// the club publishes to the world lives on the marketing pages and the blog;
// this is the reading it gives the people who train here, so a signed-out
// visitor is sent to sign in rather than shown a shell with an empty sidebar.
// The gate is a redirect and therefore a courtesy: the lock is `canReadArticle`,
// which every read goes through server-side.
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AuthPending } from "@/components/site/AuthPending";
import { KbLayout } from "@/components/site/KbLayout";

export const Route = createFileRoute("/kb")({
  // `ssr: false` for the same reason as `_authenticated`: the session lives in
  // the browser, so a server render would decide the reader is signed out.
  ssr: false,
  // Timings copied from `_authenticated`, where the reasoning is written out: a
  // warm load resolves from local storage in a few dozen milliseconds and should
  // go straight to the article rather than flashing a spinner at it.
  pendingMs: 100,
  pendingMinMs: 300,
  pendingComponent: () => <AuthPending label="Loading the knowledge base" />,
  beforeLoad: async ({ location }) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      // Without the hash: on a failed email link the fragment holds Supabase's
      // error params, and they would be carried into the post-sign-in redirect.
      throw redirect({
        to: "/auth",
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }
  },
  component: KbSection,
});

function KbSection() {
  return (
    <KbLayout>
      <Outlet />
    </KbLayout>
  );
}
