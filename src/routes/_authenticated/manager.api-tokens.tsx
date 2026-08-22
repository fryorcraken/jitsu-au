import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CopyButton } from "@/components/site/CopyButton";
import { formatDateTime } from "@/lib/dates";
import { createApiToken, listApiTokens, revokeApiToken } from "@/lib/manager-api-tokens.functions";
import { buildAgentPrompt } from "@/lib/manager-api-tokens";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/api-tokens")({
  head: () => ({
    meta: [{ title: "Agent access | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ApiTokensPage,
});

type TokenRow = {
  id: string;
  label: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  active: boolean;
};

function ApiTokensPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  const fetchTokens = useServerFn(listApiTokens);
  const create = useServerFn(createApiToken);
  const revoke = useServerFn(revokeApiToken);

  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  // The raw token is shown exactly once, right after creation.
  const [freshToken, setFreshToken] = useState<{ label: string; token: string } | null>(null);

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "https://jitsu.au";
  const agentPrompt = useMemo(() => buildAgentPrompt({ baseUrl }), [baseUrl]);
  const manifestUrl = `${baseUrl}/api/manager/agent`;

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useCallback(() => {
    setLoading(true);
    fetchTokens()
      .then((rows) => {
        setTokens(rows);
        setLoadError(null);
      })
      .catch((e) => {
        const message = describeLoadError(e, "Could not load the tokens");
        setLoadError(message);
        toast.error(message);
      })
      .finally(() => setLoading(false));
  }, [fetchTokens]);

  useEffect(() => {
    if (!isManager) return;
    load();
  }, [isManager, load]);

  async function onCreate() {
    if (!label.trim()) {
      toast.error("Give the token a name first.");
      return;
    }
    setCreating(true);
    try {
      const created = await create({ data: { label: label.trim() } });
      setFreshToken({ label: created.label, token: created.token });
      setLabel("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create token");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    if (!confirm("Revoke this token? Any agent using it will immediately lose access.")) return;
    try {
      await revoke({ data: { id } });
      toast.success("Token revoked");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not revoke token");
    }
  }

  if (loading) return <Loading className="p-8" />;

  return (
    <>
      <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Agent access</h1>
            <p className="text-sm text-muted-foreground">
              Create API tokens so an AI agent can run manager tasks (list members, edit invoices)
              for you.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/manager/memberships">Back to memberships</Link>
          </Button>
        </div>

        {/* One-time reveal of a freshly created token. */}
        {freshToken && (
          <Alert>
            <KeyRound className="size-4" />
            <AlertTitle>Copy your new token now: it won't be shown again</AlertTitle>
            <AlertDescription>
              <div className="mt-2 space-y-3">
                <p className="text-sm text-muted-foreground">
                  Token <span className="font-medium text-foreground">{freshToken.label}</span>.
                  Store it as the <code className="font-mono">UTS_MANAGER_API_KEY</code> environment
                  variable for your agent.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-sm">
                    {freshToken.token}
                  </code>
                  <CopyButton text={freshToken.token} label="Copy token" />
                </div>
                <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
                  I've saved it
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Create a token. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create a token</CardTitle>
            <CardDescription>
              Name it after where it's used (e.g. "Claude Code – laptop") so you can revoke it
              later.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1">
                <Label htmlFor="label">Token name</Label>
                <Input
                  id="label"
                  value={label}
                  maxLength={80}
                  placeholder="Claude Code – laptop"
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onCreate()}
                  className="mt-2"
                />
              </div>
              <Button onClick={onCreate} disabled={creating}>
                {creating ? "Creating..." : "Create token"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Existing tokens. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your tokens</CardTitle>
            <CardDescription>
              Revoke a token to immediately cut off any agent using it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadError ? (
              <LoadFailure
                what="The tokens"
                message={loadError}
                hint="This is not the same as having none, so a token you issued earlier may well still be live."
                onRetry={load}
              />
            ) : tokens.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tokens yet.</p>
            ) : (
              <ul className="divide-y">
                {tokens.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{t.label || "(unnamed)"}</span>
                        {t.active ? (
                          <Badge variant="secondary">Active</Badge>
                        ) : (
                          <Badge variant="outline">Revoked</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <code className="font-mono">{t.token_prefix}…</code> · created{" "}
                        {formatDateTime(t.created_at)} · last used {formatDateTime(t.last_used_at)}
                      </p>
                    </div>
                    {t.active && (
                      <Button variant="outline" size="sm" onClick={() => onRevoke(t.id)}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Onboarding: paste-able prompt for the manager's own coding agent. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect your agent</CardTitle>
            <CardDescription>
              Paste this into Claude Code, opencode, Cursor, or any coding agent, then give it the
              token when it asks.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Agent prompt</Label>
                <CopyButton text={agentPrompt} label="Copy prompt" />
              </div>
              <pre className="max-h-80 overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                {agentPrompt}
              </pre>
            </div>

            <div className="rounded-md border p-3 text-sm text-muted-foreground">
              <p>
                The action list is always live at{" "}
                <a className="underline" href={manifestUrl}>
                  {manifestUrl}
                </a>{" "}
                (send your token as a Bearer header).
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
