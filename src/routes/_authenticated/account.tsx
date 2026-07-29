import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Pill } from "@/components/site/StatusPill";
import { formatDate } from "@/lib/dates";
import { waiverClass } from "@/lib/status-colours";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { connectAppUser } from "@/integrations/lovable/appUserConnectorClient";
import {
  disconnectGoogleDrive,
  getGoogleDriveStatus,
  saveGoogleDriveConnection,
  startGoogleDriveConnect,
} from "@/lib/google-drive.functions";
import { getWaiverPdfUrl, listMyWaivers } from "@/lib/waiver.functions";
import { requestMyEmailVerification } from "@/lib/email-verification.functions";
import { isEmailVerified } from "@/lib/email-verification";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({
    meta: [{ title: "Your account | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: AccountPage,
});

/**
 * Whether this account's address has been confirmed, and a way to ask for a
 * fresh link if not.
 *
 * `email_confirmed_at` is already on the session user, so this needs no server
 * round trip to render. Most people reading this page arrived by clicking a
 * sign-in link, which is itself the proof, so for them it is just reassurance.
 */
function EmailVerificationNote({
  email,
  emailConfirmedAt,
}: {
  email: string | undefined;
  emailConfirmedAt: string | undefined;
}) {
  const requestVerification = useServerFn(requestMyEmailVerification);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (isEmailVerified(emailConfirmedAt)) {
    return <span className="text-green-700"> · email confirmed</span>;
  }

  async function send() {
    setBusy(true);
    try {
      const res = await requestVerification();
      setSent(true);
      toast.success(
        res.alreadyVerified
          ? "Your email is already confirmed."
          : `Confirmation link sent to ${email ?? "your email"}.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send that email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {" · "}
      <span className="text-amber-700">email not confirmed yet</span>{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0"
        disabled={busy}
        onClick={send}
      >
        {busy ? "Sending..." : sent ? "Send again" : "Send verification email"}
      </Button>
    </>
  );
}

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
          <EmailVerificationNote email={user.email} emailConfirmedAt={user.email_confirmed_at} />
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
                  Signed {formatDate(w.signed_at)}
                  {w.template_version != null && (
                    <span className="text-muted-foreground"> (v{w.template_version})</span>
                  )}{" "}
                  {/* The same three statuses, and the same colours, a manager
                      sees. The two-way ternary this replaced painted a
                      superseded waiver exactly like a pending one, so a member
                      who had re-signed could not tell which one counted. */}
                  <Pill label={w.status} className={waiverClass(w.status)} />
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

// Note: there is deliberately no self-serve "change email" here. The email IS
// the person's identity (one profile per email), so changing it must update the
// profile and the login together. That is a manager/support action for now.
