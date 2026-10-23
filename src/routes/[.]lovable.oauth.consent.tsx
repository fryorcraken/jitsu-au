// Where an assistant (Claude Code, Claude, Cursor...) sends a manager to
// approve its connection to the club's MCP server. The OAuth server itself is
// the club's own sign-in; this page only asks "let this app act as you?".
// Client-only: the session lives in the browser, so SSR would always see a
// signed-out visitor and bounce them to /auth.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Loading } from "@/components/site/Loading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connect an assistant | UTS Jitsu" },
      {
        name: "description",
        content: "Approve an AI assistant's access to your UTS Jitsu manager tools.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      throw redirect({
        to: "/auth",
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }
  },
  loaderDeps: ({ search }) => ({ authorizationId: search.authorization_id }),
  loader: async ({ deps }) => {
    if (!deps.authorizationId) return { state: "missing" as const };
    const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(
      deps.authorizationId,
    );
    if (error) throw error;
    // Already approved before: go straight back to the assistant.
    if (data && "redirect_url" in data && !("client" in data)) {
      throw redirect({ href: data.redirect_url });
    }
    if (!data || !("client" in data)) return { state: "missing" as const };
    return {
      state: "ready" as const,
      clientName: data.client.name || "An assistant",
      email: data.user.email,
    };
  },
  pendingComponent: () => (
    <SiteLayout>
      <Loading className="p-8" label="Loading the connection request..." />
    </SiteLayout>
  ),
  errorComponent: () => (
    <ConsentShell title="This link has expired">
      <p className="text-sm text-muted-foreground">
        Connection requests only last a few minutes. Go back to your assistant and start connecting
        again.
      </p>
    </ConsentShell>
  ),
  component: Consent,
});

function ConsentShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">{children}</CardContent>
        </Card>
      </section>
    </SiteLayout>
  );
}

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (details.state === "missing") {
    return (
      <ConsentShell title="Nothing to approve">
        <p className="text-sm text-muted-foreground">
          This page opens when an assistant asks to connect to your club account. Start connecting
          from your assistant and it will bring you back here.
        </p>
      </ConsentShell>
    );
  }

  async function decide(approve: boolean) {
    setBusy(approve ? "approve" : "deny");
    setError(null);
    const { data, error } = approve
      ? await supabase.auth.oauth.approveAuthorization(authorization_id, {
          skipBrowserRedirect: true,
        })
      : await supabase.auth.oauth.denyAuthorization(authorization_id, {
          skipBrowserRedirect: true,
        });
    if (error || !data?.redirect_url) {
      setBusy(null);
      setError(
        "We could not reach the club's sign-in just now. Try again, or start connecting again from your assistant.",
      );
      return;
    }
    window.location.href = data.redirect_url;
  }

  return (
    <ConsentShell title={`Connect ${details.clientName}?`}>
      <p className="text-sm">
        <strong>{details.clientName}</strong> wants to use the club's manager tools as{" "}
        <strong>{details.email}</strong>.
      </p>
      <p className="text-sm text-muted-foreground">
        It will be able to look up members and invoices, and make the same changes you can make as
        a manager, including ones that email members. Only connect an assistant you trust. Only
        club managers can use these tools.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy !== null} onClick={() => decide(true)}>
          {busy === "approve" ? "Connecting..." : "Approve"}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => decide(false)}>
          {busy === "deny" ? "Cancelling..." : "Deny"}
        </Button>
      </div>
    </ConsentShell>
  );
}
