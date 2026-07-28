import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AuthPending } from "@/components/site/AuthPending";
import { MemberLayout } from "@/components/site/MemberLayout";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  // The gate always waits on the Supabase client finishing its initialisation,
  // and on an email-link landing that includes a round trip to turn the tokens
  // in the URL fragment into a session. Without a pending component that wait
  // is a blank white page.
  //
  // The timings matter as much as having the component at all. A warm load
  // resolves from local storage in a few dozen ms and should go straight to
  // content, so hold off for 100ms before showing anything (the router's own
  // default is 1000ms, which is long enough to be the blank page we are fixing).
  // pendingMinMs then keeps the spinner up long enough to not read as a flicker
  // once it has appeared; the router's 500ms default would put that floor under
  // every member page load.
  pendingMs: 100,
  pendingMinMs: 300,
  pendingComponent: () => <AuthPending label="Loading your account" />,
  beforeLoad: async ({ location }) => {
    // getSession() resolves from local storage once the client has initialised,
    // which is also what consumes an email link's `#access_token=...` fragment.
    // getUser() would add a second, serialised network round trip in front of
    // every member page for no gain here: this gate decides what to *show*, and
    // access to data is enforced server-side by RLS and requireSupabaseAuth.
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      // Deliberately without the hash: on a failed email link the fragment
      // holds Supabase's error params, and they would be carried back into the
      // post-sign-in redirect target.
      throw redirect({
        to: "/auth",
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }
  },
  component: () => (
    <MemberLayout>
      <Outlet />
    </MemberLayout>
  ),
});
