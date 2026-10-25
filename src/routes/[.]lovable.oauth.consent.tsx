// Where an assistant (Claude Code, Claude, Cursor...) sends a manager to
// approve its connection to the club's MCP server. The OAuth server itself is
// the club's own sign-in; this page only asks "let this app act as you?".
// Client-only: the session lives in the browser, so SSR would always see a
// signed-out visitor and bounce them to /auth.
//
// Two things this page defends against, because approving here hands the
// assistant a full sign-in as this person, not just the club tools:
// - A lookalike app. Assistants register themselves, so the name shown is
//   whatever they chose. The address the approval goes to is not, so the page
//   names it (src/lib/oauth-consent.ts).
// - A member being talked into it. The tools refuse non-managers anyway, but
//   the sign-in would still be handed over, so a non-manager is never offered
//   Approve at all.
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Loading } from "@/components/site/Loading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { describeRedirectTarget, type RedirectTarget } from "@/lib/oauth-consent";

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
    const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(deps.authorizationId);
    if (error) throw error;
    if (!data) return { state: "missing" as const };
    // Already approved before: go straight back to the assistant.
    if (!("authorization_id" in data)) throw redirect({ href: data.redirect_url });
    const clientName = data.client.name || "An assistant";
    const { data: isManager, error: roleError } = await supabase.rpc("has_role", {
      _user_id: data.user.id,
      _role: "manager",
    });
    if (roleError) throw roleError;
    if (!isManager) {
      return { state: "not-manager" as const, clientName, email: data.user.email };
    }
    return {
      state: "ready" as const,
      clientName,
      email: data.user.email,
      target: describeRedirectTarget(data.redirect_uri),
    };
  },
  pendingComponent: () => (
    <SiteLayout>
      <Loading className="p-8" label="Loading the connection request..." />
    </SiteLayout>
  ),
  errorComponent: ConsentError,
  component: Consent,
});

function ConsentShell({
  title,
  pageState,
  children,
}: {
  title: string;
  /** `data-page-state="error"` tells the e2e tour this is a failure boundary. */
  pageState?: "error";
  children: React.ReactNode;
}) {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-md px-4 py-16" data-page-state={pageState}>
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

// An expired request and a sign-in server that did not answer look the same
// from here, so the page offers both ways out rather than guessing.
function ConsentError() {
  const router = useRouter();
  return (
    <ConsentShell title="We couldn't open this connection request" pageState="error">
      <p className="text-sm text-muted-foreground">
        Connection requests only last a few minutes. If you started a while ago, go back to your
        assistant and start connecting again. If you only just started, try again.
      </p>
      <Button variant="outline" onClick={() => router.invalidate()}>
        Try again
      </Button>
    </ConsentShell>
  );
}

function TargetLine({ target }: { target: RedirectTarget }) {
  switch (target.kind) {
    case "website":
      return (
        <>
          If you approve, access is sent to <strong>{target.host}</strong>.
        </>
      );
    case "this-computer":
      return (
        <>
          If you approve, access is sent to a program running on this computer. That is how Claude
          Code and other desktop assistants connect.
        </>
      );
    case "app":
      return (
        <>
          If you approve, access is sent to the app on this device that opens{" "}
          <strong>{target.scheme}:</strong> links.
        </>
      );
    case "unknown":
      return <>We can't tell where access will be sent.</>;
  }
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

  const failure = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );

  if (details.state === "not-manager") {
    return (
      <ConsentShell title="This account can't connect an assistant">
        <p className="text-sm">
          <strong>{details.clientName}</strong> asked to use the club's manager tools, but you're
          signed in as <strong>{details.email}</strong>, which isn't a manager account.
        </p>
        <p className="text-sm text-muted-foreground">
          If you manage the club with a different login, sign out, then start connecting again from
          your assistant and sign in with that one.
        </p>
        {failure}
        <Button variant="outline" disabled={busy !== null} onClick={() => decide(false)}>
          {busy === "deny" ? "Cancelling..." : "Cancel the request"}
        </Button>
      </ConsentShell>
    );
  }

  return (
    <ConsentShell title={`Connect ${details.clientName}?`}>
      <p className="text-sm">
        <strong>{details.clientName}</strong> wants to sign in to the club as{" "}
        <strong>{details.email}</strong>. <TargetLine target={details.target} />
      </p>
      <p className="text-sm text-muted-foreground">
        It will be able to look up members and invoices and make the changes you can make as a
        manager, including ones that email members. It can also reach anything else your login can.
        You can remove it at any time from{" "}
        <Link to="/manager/api-tokens" className="underline">
          Agent access
        </Link>
        .
      </p>
      <p className="text-sm font-medium">
        If you didn't just start connecting from your own assistant, or you don't recognise where
        access is going, choose Deny.
      </p>
      {failure}
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
