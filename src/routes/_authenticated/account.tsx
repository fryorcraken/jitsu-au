import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { connectAppUser } from "@/integrations/lovable/appUserConnectorClient";
import {
  disconnectGoogleDrive,
  getGoogleDriveStatus,
  saveGoogleDriveConnection,
  startGoogleDriveConnect,
} from "@/lib/google-drive.functions";
import { getWaiverPdfUrl, listMyWaivers } from "@/lib/waiver.functions";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({
    meta: [{ title: "Your account | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: AccountPage,
});

function AccountPage() {
  const { user } = useAuth();
  const { roles, isManager } = useRoles(user?.id);

  if (!user) return null;

  return (
    <section className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      <div>
        <h1 className="text-3xl font-black">Your account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as <strong>{user.email}</strong>
          {roles.length > 0 && <> · Roles: {roles.join(", ")}</>}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Membership</CardTitle>
          <CardDescription>View your status, pick a plan, or renew.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/membership">Manage membership</Link>
          </Button>
        </CardContent>
      </Card>

      <WaiversCard />

      {isManager && <GoogleDriveCard />}

      <ChangePasswordCard />
      <ChangeEmailCard currentEmail={user.email ?? ""} />
    </section>
  );
}

type MyWaiver = {
  id: string;
  signed_at: string;
  template_version: number | null;
  has_pdf: boolean;
  status: "pending" | "active" | "superseded";
};

function WaiversCard() {
  const fetchMine = useServerFn(listMyWaivers);
  const getUrl = useServerFn(getWaiverPdfUrl);
  const [waivers, setWaivers] = useState<MyWaiver[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMine()
      .then((rows) => setWaivers(rows as MyWaiver[]))
      .catch(() => setWaivers([]))
      .finally(() => setLoading(false));
  }, [fetchMine]);

  async function download(id: string) {
    try {
      const { url } = await getUrl({ data: { id } });
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to get PDF");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Waivers</CardTitle>
        <CardDescription>
          Your waiver history. The active waiver is the latest one the club approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : waivers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No waivers on file yet.</p>
        ) : (
          <ul className="space-y-2">
            {waivers.map((w) => (
              <li
                key={w.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span>
                  Signed {new Date(w.signed_at).toLocaleDateString("en-AU")}
                  {w.template_version != null && (
                    <span className="text-muted-foreground"> (v{w.template_version})</span>
                  )}
                  <span
                    className={
                      w.status === "active"
                        ? "ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary"
                        : "ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                    }
                  >
                    {w.status}
                  </span>
                </span>
                {w.has_pdf && (
                  <Button size="sm" variant="outline" onClick={() => download(w.id)}>
                    Download PDF
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <Button asChild variant="outline" size="sm">
          <Link to="/waiver">Sign an updated waiver</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function GoogleDriveCard() {
  const status = useServerFn(getGoogleDriveStatus);
  const start = useServerFn(startGoogleDriveConnect);
  const save = useServerFn(saveGoogleDriveConnection);
  const disconnect = useServerFn(disconnectGoogleDrive);

  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    status()
      .then((s) => {
        setConnected(s.connected);
        setEmail(s.connected ? (s.email ?? null) : null);
      })
      .catch(() => {
        setConnected(false);
        setEmail(null);
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onConnect() {
    setBusy(true);
    try {
      const result = await connectAppUser({
        connectorId: "google_drive",
        gatewayBaseUrl: "https://connector-gateway.lovable.dev",
        start: (targetOrigin) => start({ data: targetOrigin }),
      });
      if (!result.success) {
        toast.error(result.error ?? "Connection cancelled");
        return;
      }
      if (!result.connectionAPIKey) {
        toast.error("Google did not grant offline access. Contact support.");
        return;
      }
      const saved = await save({ data: { connectionAPIKey: result.connectionAPIKey } });
      toast.success(saved.email ? `Connected as ${saved.email}` : "Google Drive connected");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await disconnect();
      toast.success("Google Drive disconnected");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Drive</CardTitle>
        <CardDescription>
          Connect your Google account to save signed waivers to a &ldquo;UTS Jitsu Waivers&rdquo;
          folder in your Drive.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              Connected
              {email ? (
                <>
                  {" "}
                  as <strong>{email}</strong>
                </>
              ) : null}
              .
            </p>
            <Button variant="outline" onClick={onDisconnect} disabled={busy}>
              {busy ? "Working..." : "Disconnect"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Not connected. Only files this app creates will be visible to it.
            </p>
            <Button onClick={onConnect} disabled={busy}>
              {busy ? "Opening..." : "Connect Google Drive"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChangePasswordCard() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return toast.error(error.message);
    setPassword("");
    toast.success("Password updated");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="cp">New password</Label>
            <Input
              id="cp"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving..." : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangeEmailCard({ currentEmail }: { currentEmail: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => setEmail(currentEmail), [currentEmail]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (email === currentEmail) return;
    setBusy(true);
    const { error } = await supabase.auth.updateUser(
      { email },
      { emailRedirectTo: `${window.location.origin}/account` },
    );
    setBusy(false);
    if (error) return toast.error(error.message);
    setPending(true);
    toast.success("Confirmation emails sent to both addresses");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change email</CardTitle>
        <CardDescription>
          You'll receive a confirmation link at both your current and new email address.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="ce">Email</Label>
            <Input
              id="ce"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || email === currentEmail}>
            {busy ? "Sending..." : "Update email"}
          </Button>
          {pending && (
            <p className="text-sm text-muted-foreground">
              Change pending. Confirm from both inboxes to complete.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
