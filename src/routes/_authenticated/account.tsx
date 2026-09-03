import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { NewPasswordField } from "@/components/site/NewPasswordField";
import { CalendarLinkPanel } from "@/components/site/CalendarLinkPanel";
import { describePasswordError, passwordProblem, type BreachStatus } from "@/lib/password-policy";
import { AboutYouCard } from "@/components/site/account/AboutYouCard";
import { CodeOfConductCard } from "@/components/site/account/CodeOfConductCard";
import { ContactCard } from "@/components/site/account/ContactCard";
import type { Profile } from "@/components/site/account/DetailsCard";
import { subjectVoice } from "@/lib/subject-voice";
import { HouseholdCard } from "@/components/site/account/HouseholdCard";
import { listMyHousehold, type HouseholdPerson } from "@/lib/household.functions";
import { KitSizingCard } from "@/components/site/account/KitSizingCard";
import { MediaConsentCard } from "@/components/site/account/MediaConsentCard";
import { WaiversCard } from "@/components/site/account/WaiversCard";
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
import { getMyProfile } from "@/lib/waiver.functions";
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
 * sign-in link they requested, which is itself the proof, so for them it is
 * just reassurance.
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

/** A group heading, so eight cards stop reading as one undifferentiated stack. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="pt-4 text-xs font-bold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

function AccountPage() {
  const { user } = useAuth();
  const { roles, isManager } = useRoles(user?.id);
  const fetchProfile = useServerFn(getMyProfile);
  const fetchHousehold = useServerFn(listMyHousehold);
  // Every card below is about a PERSON rather than about the session, and this
  // page is the case where that person is the caller. The cards themselves
  // hold no opinion, which is what lets the same six render somebody else on
  // their account (see `src/components/site/account/`).
  const userId = user?.id;

  // Fetched once here rather than per card: the three editable cards below all
  // read the same row, and three identical round trips would only give them
  // three chances to disagree about what is on file.
  const [profile, setProfile] = useState<Profile>(null);
  // Who else is on this account. Fetched HERE rather than inside the card that
  // lists them, because the page needs the same answer twice: once to list
  // them, and once to decide whether the person reading has any records of
  // their own to show. Two fetches would give the page two chances to disagree
  // with the card sitting on it.
  const [household, setHousehold] = useState<HouseholdPerson[]>([]);
  const [householdError, setHouseholdError] = useState<string | null>(null);
  // Tracked separately from `loading` below, which is about the profile row.
  // Until this answers, the page does not yet know whether the person reading
  // is a parent who never trains, and the four cards that depend on that must
  // not be painted only to be taken away a moment later.
  const [householdLoading, setHouseholdLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  // A failed fetch is NOT "you have no details". Conflating the two renders the
  // cards editable and empty, and one Save then writes those blanks over a
  // record that was there all along. Tracked separately so the page can say the
  // honest thing and offer a retry instead.
  const [loadFailed, setLoadFailed] = useState(false);

  const loadHousehold = useCallback(() => {
    setHouseholdLoading(true);
    return fetchHousehold()
      .then((rows) => {
        setHousehold(rows);
        setHouseholdError(null);
      })
      .catch((e) => {
        setHousehold([]);
        setHouseholdError(describeLoadError(e, "Could not load the people on your account"));
      })
      .finally(() => setHouseholdLoading(false));
  }, [fetchHousehold]);

  const load = useCallback(() => {
    // Waiting for the id is a real (small) behaviour change, and in the right
    // direction. Before, a mount that beat the session resolving fired anyway,
    // failed the auth middleware, set `loadFailed`, and never retried, because
    // this callback did not depend on the user. That parked the member on "We
    // couldn't load your details" until they reloaded. The route's own gate
    // makes it rare, not impossible.
    if (!userId) return;
    setLoading(true);
    setLoadFailed(false);
    fetchProfile({ data: { userId } })
      .then((p) => setProfile(p))
      .catch(() => {
        setProfile(null);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
    // Its own failure, deliberately. A household that will not load must not
    // take down the details cards below it, and it must not silently read as
    // "nobody is on your account" either.
    loadHousehold();
  }, [fetchProfile, userId, loadHousehold]);

  useEffect(load, [load]);

  if (!user || !userId) return null;

  const dependants = household.filter((p) => !p.is_self);
  const self = household.find((p) => p.is_self) ?? null;
  // A parent-only account: somebody who holds the login for their children and
  // does not train themselves. They have no waiver, no kit sizes and no photo
  // consent, so those cards would be four empty prompts to do things that do
  // not apply to them.
  //
  // Both halves are required, and defaulting to "shows everything" is the
  // safe direction. Somebody with no dependants is an ordinary member who has
  // not signed yet and needs every card; and a household that failed to load
  // leaves `self` null, which must not hide a member's own records behind a
  // dropped connection.
  const parentOnly = dependants.length > 0 && self != null && !self.has_any_waiver;
  // "Show this person their own records." False while the household is still
  // in flight as well as for a parent-only account: `parentOnly` is false
  // during that window because `household` is still `[]`, so keying the cards
  // on it alone paints kit sizing, photos, waivers and the code of conduct,
  // each with its own spinner, and then removes all four when the answer
  // lands. Withholding them for that moment and adding them is the calmer of
  // the two, and it is the direction that never takes something away.
  const ownRecords = !householdLoading && !parentOnly;

  // Second person, because this page is about the person reading it. The same
  // cards on `/account/<id>` are handed a name instead.
  const voice = subjectVoice(null);
  const details = { userId, voice, profile, loading, onSaved: setProfile };

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

      {/* First card on the page, and written for somebody who has not been yet.
          Everything below it is admin you visit when something needs doing; this
          is the one thing a new member should read before their first class. */}
      <Card>
        <CardHeader>
          <CardTitle>Knowledge base</CardTitle>
          <CardDescription>
            How we train, how grading works, and what to expect. Start at the beginning and work
            through it, or search for what you need.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/kb">Open the knowledge base</Link>
          </Button>
        </CardContent>
      </Card>

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

      {/* Above "Your details", because who is on the account is the frame for
          everything below it. Renders nothing at all for an account with no
          dependants, which is almost every account. */}
      <HouseholdCard
        people={household}
        loading={householdLoading}
        loadError={householdError}
        onRetry={loadHousehold}
      />

      <SectionHeading>Your details</SectionHeading>

      {loadFailed ? (
        <Card>
          <CardHeader>
            <CardTitle>We couldn't load your details</CardTitle>
            <CardDescription>
              Nothing has changed, and nothing is lost. This is usually a dropped connection, so try
              again in a moment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={load}>Try again</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <AboutYouCard {...details} />

          {/* A parent who holds the login for their children and does not train
              has no kit to be sized and is in no photograph, so these two would
              be prompts to answer questions that do not apply to them. Contact
              details still do: they are how the club reaches the family. */}
          {ownRecords ? <KitSizingCard {...details} /> : null}

          <ContactCard {...details} />

          {ownRecords ? <MediaConsentCard {...details} /> : null}
        </>
      )}

      {/* Held back until the household lands for the same reason as the cards
          above: the two sentences say different things, and the majority case
          is the second one, so guessing would show most people the wrong note
          and then swap it under them. */}
      {householdLoading ? null : (
        <p className="text-xs text-muted-foreground">
          {parentOnly
            ? "Your email is your login, so a manager changes that one. Everything about the people on your account is on their own pages."
            : "Your legal name and date of birth are not editable here, because a signed waiver records them as they were given. Ask us and we will correct them. Your email is your login, so a manager changes that one too."}
        </p>
      )}

      {/* Nothing to show somebody who has signed nothing and agreed to nothing.
          The people they look after each have their own records, on their own
          pages, which the card above links to. */}
      {ownRecords ? (
        <>
          <SectionHeading>Your records</SectionHeading>

          <WaiversCard userId={userId} voice={voice} />

          <CodeOfConductCard userId={userId} voice={voice} />
        </>
      ) : null}

      <SectionHeading>Calendar</SectionHeading>

      <Card>
        <CardHeader>
          <CardTitle>Your calendar link</CardTitle>
          <CardDescription>
            The private link that keeps the club calendar in your own calendar app. Anyone who has
            it can see what's on, so keep it to yourself. If it has ended up somewhere it shouldn't,
            replace it and the old one stops working.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CalendarLinkPanel />
        </CardContent>
      </Card>

      <SectionHeading>Sign-in</SectionHeading>

      <ChangePasswordCard
        personal={[
          user?.email,
          profile?.first_name,
          profile?.middle_name,
          profile?.last_name,
          profile?.preferred_name,
        ]}
      />

      {isManager && (
        <>
          <SectionHeading>Manager tools</SectionHeading>
          <GoogleDriveCard />
        </>
      )}
    </section>
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedFolderName, setSavedFolderName] = useState<string | null>(null);
  const [folderNameInput, setFolderNameInput] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    return status()
      .then((s) => {
        setLoadError(null);
        setConnected(s.connected);
        setEmail(s.connected ? (s.email ?? null) : null);
        const name = s.connected ? (s.folderName ?? null) : null;
        setSavedFolderName(name);
        setFolderNameInput(name ?? DEFAULT_FOLDER_NAME);
      })
      .catch((e) => {
        // Not "not connected". That offers a manager the Google consent screen
        // for an account that is already linked, and a folder box that would
        // overwrite the folder they already chose.
        setLoadError(describeLoadError(e, "Could not check your Drive connection"));
        setConnected(false);
        setEmail(null);
        setSavedFolderName(null);
      })
      .finally(() => setLoading(false));
  };

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
      toast.error(e instanceof Error ? e.message : "Could not connect Google Drive. Try again.");
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
      toast.error(e instanceof Error ? e.message : "Could not disconnect Google Drive. Try again.");
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
      toast.error(e instanceof Error ? e.message : "Could not save the folder name. Try again.");
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
      toast.error(
        e instanceof Error
          ? e.message
          : "Could not open the folder picker. Type the folder name instead.",
      );
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
          <Loading />
        ) : loadError ? (
          <LoadFailure
            what="Your Drive connection"
            message={loadError}
            hint="This is not the same as it being disconnected, so any folder you set is still set."
            onRetry={() => void refresh()}
          />
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

function ChangePasswordCard({ personal }: { personal: (string | null | undefined)[] }) {
  const [password, setPassword] = useState("");
  const [breach, setBreach] = useState<BreachStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Say what is wrong here rather than spending a round trip to be told.
    const local = passwordProblem(password, { personal, breach });
    if (local) return setProblem(local);
    setProblem(null);
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    // Not a toast: this stops somebody, so it has to still be on screen while
    // they fix it, next to the rules it is about.
    if (error) return setProblem(describePasswordError(error.message));
    setPassword("");
    toast.success("Password updated");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <NewPasswordField
            id="cp"
            label="New password"
            disabled={busy}
            value={password}
            // Clear the refusal as soon as they start fixing it. A red panel
            // sitting under rules that have since gone green is worse than no
            // panel.
            onChange={(next) => {
              setPassword(next);
              setProblem(null);
            }}
            onBreachChange={setBreach}
            personal={personal}
          />
          {problem && (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
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
