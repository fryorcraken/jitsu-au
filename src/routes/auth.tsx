import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { AuthPending } from "@/components/site/AuthPending";
import { SignInForms } from "@/components/site/SignInForms";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const searchSchema = z.object({
  redirect: z.string().optional(),
  // Kept for old links; there is no self-serve sign-up any more, so any mode
  // lands on the sign-in form.
  mode: z.enum(["signin", "signup"]).optional().catch(undefined),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Sign in | UTS Jitsu" },
      { name: "description", content: "Sign in to your UTS Jitsu account." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { redirect } = useSearch({ from: "/auth" });
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) navigate({ to: redirect ?? "/account" });
      else setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [navigate, redirect]);

  // Never render nothing here. Someone already signed in is on their way to
  // their account, and if that hand-off stalls a spinner is a far better thing
  // to be looking at than a blank page.
  if (!ready) return <AuthPending label="Checking your sign-in" />;

  // There is no self-serve sign-up: your login is set up by the club when a
  // manager approves your waiver, via the invite email.
  return (
    <SiteLayout>
      <section className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SignInForms redirect={redirect} />
            <p className="text-xs text-muted-foreground">
              No login yet?{" "}
              <Link to="/waiver" className="text-primary hover:underline">
                Sign the training waiver
              </Link>{" "}
              and we'll set up your account once the club approves it.
            </p>
          </CardContent>
        </Card>
      </section>
    </SiteLayout>
  );
}
