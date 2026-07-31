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
  DEFAULT_FOLDER_NAME,
  disconnectGoogleDrive,
  getGoogleDriveStatus,
  saveGoogleDriveConnection,
  setGoogleDriveFolder,
  setGoogleDriveFolderFromPicker,
  startGoogleDriveConnect,
} from "@/lib/google-drive.functions";
import { getWaiverPdfUrl, listMyWaivers } from "@/lib/waiver.functions";
import { getCodeOfConductSigner } from "@/lib/code-of-conduct.functions";
import type { CodeOfConductState } from "@/lib/code-of-conduct";
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

      <CodeOfConductCard />

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

/**
 * Where this member stands on the club's house rules.
 *
 * Reads through the same server function the public page uses: a signed-in
 * caller is identified by their session, so no token is involved here. Signing
 * itself happens on `/code-of-conduct`, because agreeing to a document you
 * cannot see on the same screen is not agreement.
 */
function CodeOfConductCard() {
  const fetchSigner = useServerFn(getCodeOfConductSigner);
  const [state, setState] = useState<CodeOfConductState | null>(null);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSigner({ data: { token: "" } })
      .then((res) => {
        if (!res.status) return;
        setState(res.status.state);
        setAcceptedAt(res.status.accepted_at);
        setAcceptedVersion(res.status.accepted_version);
      })
      .catch(() => {
        /* nothing to show is the honest fallback here */
      })
      .finally(() => setLoading(false));
  }, [fetchSigner]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Code of conduct</CardTitle>
        <CardDescription>
          The rules we train by. Signing it is not required before you train, and we ask for it
          around the time you join as a paying member.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : state === "signed" ? (
          <p className="text-sm text-muted-foreground">
            You agreed to version {acceptedVersion} on {formatDate(acceptedAt)}.
          </p>
        ) : state === "outdated" ? (
          <p className="text-sm text-muted-foreground">
            You agreed to version {acceptedVersion} on {formatDate(acceptedAt)}. We have updated it
            since, so please have another read.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">You have not agreed to it yet.</p>
        )}
        <Button asChild variant={state === "signed" ? "outline" : "default"} size="sm">
          <Link to="/code-of-conduct" search={{ t: undefined }}>
            {state === "signed" ? "Read the code of conduct" : "Read and sign it"}
          </Link>
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
  const setFolder = useServerFn(setGoogleDriveFolder);
  const saveFolderFromPicker = useServerFn(setGoogleDriveFolderFromPicker);

  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedFolderName, setSavedFolderName] = useState<string | null>(null);
  const [folderNameInput, setFolderNameInput] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);

  const refresh = () =>
    status()
      .then((s) => {
        setConnected(s.connected);
        setEmail(s.connected ? (s.email ?? null) : null);
        const name = s.connected ? (s.folderName ?? null) : null;
        setSavedFolderName(name);
        setFolderNameInput(name ?? DEFAULT_FOLDER_NAME);
      })
      .catch(() => {
        setConnected(false);
        setEmail(null);
        setSavedFolderName(null);
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

  async function onSaveFolder(e: React.FormEvent) {
    e.preventDefault();
    const folderName = folderNameInput.trim();
    if (!folderName) return;
    setFolderBusy(true);
    try {
      const result = await setFolder({ data: { folderName } });
      setSavedFolderName(result.folderName);
      toast.success(`Waivers will save to "${result.folderName}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to set the Drive folder");
    } finally {
      setFolderBusy(false);
    }
  }

  async function onBrowseFolder() {
    const clientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined;
    if (!clientId) {
      toast.error("Browsing isn't set up yet. Type the folder name instead.");
      return;
    }
    setPickerBusy(true);
    try {
      const { pickDriveFolder } = await import("@/lib/google-picker");
      const picked = await pickDriveFolder(clientId);
      if (!picked) return;
      const result = await saveFolderFromPicker({ data: { folderId: picked.id } });
      setSavedFolderName(result.folderName);
      setFolderNameInput(result.folderName);
      toast.success(`Waivers will save to "${result.folderName}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to pick a folder");
    } finally {
      setPickerBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Drive</CardTitle>
        <CardDescription>
          Connect your Google account to save signed waivers to a folder in your Drive.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : connected ? (
          <div className="space-y-4">
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
            <form onSubmit={onSaveFolder} className="space-y-2">
              <Label htmlFor="drive-folder-name">Drive folder</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="drive-folder-name"
                  value={folderNameInput}
                  onChange={(e) => setFolderNameInput(e.target.value)}
                  placeholder={DEFAULT_FOLDER_NAME}
                  className="max-w-xs"
                  disabled={folderBusy}
                />
                <Button type="submit" variant="outline" size="sm" disabled={folderBusy}>
                  {folderBusy ? "Saving..." : savedFolderName ? "Update folder" : "Save folder"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onBrowseFolder}
                  disabled={pickerBusy}
                >
                  {pickerBusy ? "Opening..." : "Browse in Drive"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {savedFolderName
                  ? `Waivers save to "${savedFolderName}". Browsing lets you pick any folder you have access to, including one in a shared drive; typing a name will only find one this app made before (a folder you made yourself in Drive with the same name won't be found).`
                  : "Browse to pick any folder you have access to, including one in a shared drive, or type a name and we'll create it in your own Drive (a folder you made yourself with the same name won't be found by typing)."}
              </p>
            </form>
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
