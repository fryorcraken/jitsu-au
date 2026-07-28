import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AuthPending } from "@/components/site/AuthPending";
import { MemberLayout } from "@/components/site/MemberLayout";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  // The gate always waits on the Supabase client finishing its initialisation,
  // and on an email-link landing that includes a round trip to turn the tokens
  // in the URL fragment into a session. Show the spinner straight away
  // (pendingMs: 0) so that wait reads as "loading" instead of a blank page.
  pendingMs: 0,
  pendingComponent: () => <AuthPending label="Signing you in" />,
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
