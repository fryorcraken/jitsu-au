import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Pill } from "@/components/site/StatusPill";
import { NewPasswordField } from "@/components/site/NewPasswordField";
import { describePasswordError, passwordProblem, type BreachStatus } from "@/lib/password-policy";
import {
  BELT_SIZE_HINT,
  BeltSizeSelect,
  GI_SIZE_HINT,
  GiSizeSelect,
} from "@/components/site/KitSizeSelect";
import type { BeltSize, GiSize } from "@/lib/kit-sizes";
import { isBeltSize, isGiSize } from "@/lib/kit-sizes";
import { formatDate } from "@/lib/dates";
import { mediaConsentClass, waiverClass } from "@/lib/status-colours";
import { mediaConsentLabel } from "@/lib/waiver-acknowledgements";
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
import { getMyProfile, getWaiverPdfUrl, listMyWaivers } from "@/lib/waiver.functions";
import { getCodeOfConductSigner } from "@/lib/code-of-conduct.functions";
import type { CodeOfConductState } from "@/lib/code-of-conduct";
import { requestMyEmailVerification } from "@/lib/email-verification.functions";
import { isEmailVerified } from "@/lib/email-verification";
import { updateMyProfile } from "@/lib/profile.functions";
import { commentDisplayName } from "@/lib/validation";
import type { UpdateMyProfileInput } from "@/lib/validation";

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

type Profile = Awaited<ReturnType<typeof getMyProfile>>;

function AccountPage() {
  const { user } = useAuth();
  const { roles, isManager } = useRoles(user?.id);
  const fetchProfile = useServerFn(getMyProfile);

  // Fetched once here rather than per card: the three editable cards below all
  // read the same row, and three identical round trips would only give them
  // three chances to disagree about what is on file.
  const [profile, setProfile] = useState<Profile>(null);
  const [loading, setLoading] = useState(true);
  // A failed fetch is NOT "you have no details". Conflating the two renders the
  // cards editable and empty, and one Save then writes those blanks over a
  // record that was there all along. Tracked separately so the page can say the
  // honest thing and offer a retry instead.
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    fetchProfile()
      .then((p) => setProfile(p))
      .catch(() => {
        setProfile(null);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [fetchProfile]);

  useEffect(load, [load]);

  if (!user) return null;

  const details = { profile, loading, onSaved: setProfile };

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

          <KitSizingCard {...details} />

          <ContactCard {...details} />

          <MediaConsentCard {...details} />
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Your legal name and date of birth are not editable here, because a signed waiver records
        them as they were given. Ask us and we will correct them. Your email is your login, so a
        manager changes that one too.
      </p>

      <SectionHeading>Your records</SectionHeading>

      <WaiversCard />

      <CodeOfConductCard />

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

/** What every editable card on this page is handed. */
type DetailsCardProps = {
  profile: Profile;
  loading: boolean;
  /** Called with the saved row so the page's copy of the profile stays true. */
  onSaved: (profile: Profile) => void;
};

/**
 * The shared save path for the three editable cards: send only this card's
 * keys, fold them back into the page's profile, and say so.
 *
 * Returns the `busy` flag and a `save` the card calls with its own patch, so
 * each card owns its fields and nothing else.
 */
function useDetailsSave({ profile, onSaved }: Pick<DetailsCardProps, "profile" | "onSaved">) {
  const update = useServerFn(updateMyProfile);
  const [busy, setBusy] = useState(false);

  async function save(patch: UpdateMyProfileInput, message: string, failure: string) {
    setBusy(true);
    try {
      await update({ data: patch });
      if (profile) onSaved({ ...profile, ...patch } as Profile);
      toast.success(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  return { busy, save };
}

/**
 * The buttons under every editable card.
 *
 * Save stays disabled until something actually differs from what is stored, so
 * the button tells the member whether they have unsaved work rather than
 * inviting a no-op write. Revert only appears once there is something to
 * revert: before this, the only way out of a half-typed change was reloading
 * the page, which is not an affordance anybody should have to guess.
 */
function CardActions({
  dirty,
  busy,
  onRevert,
}: {
  dirty: boolean;
  busy: boolean;
  onRevert: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" disabled={busy || !dirty}>
        {busy ? "Saving..." : "Save"}
      </Button>
      {dirty && !busy ? (
        <Button type="button" variant="outline" onClick={onRevert}>
          Revert
        </Button>
      ) : null}
      {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
    </div>
  );
}

/**
 * What the club calls this person, and what other members see next to their
 * comments. `commentDisplayName` doubles as the placeholder, so the field shows
 * exactly what will be used if they clear it.
 */
function AboutYouCard({ profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save } = useDetailsSave({ profile, onSaved });
  const [preferredName, setPreferredName] = useState("");
  const [displayName, setDisplayName] = useState("");

  // What is on file for the fields THIS card owns. Memoised on those values
  // alone, not on the whole `profile` object: saving any card replaces that
  // object, and resetting on its identity would silently wipe whatever the
  // member had typed into the other two cards but not yet saved.
  const stored = useMemo(
    () => ({
      preferredName: profile?.preferred_name ?? "",
      displayName: profile?.display_name ?? "",
    }),
    [profile?.preferred_name, profile?.display_name],
  );

  const revert = useMemo(
    () => () => {
      setPreferredName(stored.preferredName);
      setDisplayName(stored.displayName);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const dirty = preferredName !== stored.preferredName || displayName !== stored.displayName;

  const placeholder = profile ? commentDisplayName(profile) : "";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = displayName.trim();
    await save(
      {
        preferred_name: preferredName.trim() || null,
        display_name: name || null,
      },
      "Saved",
      "Could not save those names",
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>About you</CardTitle>
        <CardDescription>
          What we call you in person, and the name other members see on your comments.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="preferred-name">Preferred name</Label>
              <Input
                id="preferred-name"
                value={preferredName}
                onChange={(e) => setPreferredName(e.target.value)}
                maxLength={60}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                What you go by, if it is not your first name. We use it to greet you.
              </p>
            </div>
            <div>
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                placeholder={placeholder}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Shown on your blog and document comments. Leave blank to use{" "}
                {placeholder ? `"${placeholder}"` : "your first name and last initial"}.
              </p>
            </div>
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Gi and belt sizes. Kept apart from the contact card because it is the one
 * group here a manager reads in bulk (ordering kit), and because it is the only
 * one a waiver never overwrites.
 */
function KitSizingCard({ profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save } = useDetailsSave({ profile, onSaved });
  const [giSize, setGiSize] = useState<GiSize | "">("");
  const [beltSize, setBeltSize] = useState<BeltSize | "">("");

  // See AboutYouCard: keyed on this card's own fields, never on `profile`.
  const stored = useMemo(() => {
    const gi = profile?.gi_size ?? "";
    const belt = profile?.belt_size ?? "";
    return {
      giSize: (isGiSize(gi) ? gi : "") as GiSize | "",
      beltSize: (isBeltSize(belt) ? belt : "") as BeltSize | "",
    };
  }, [profile?.gi_size, profile?.belt_size]);

  const revert = useMemo(
    () => () => {
      setGiSize(stored.giSize);
      setBeltSize(stored.beltSize);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const dirty = giSize !== stored.giSize || beltSize !== stored.beltSize;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save(
      { gi_size: giSize || null, belt_size: beltSize || null },
      "Sizes saved",
      "Could not save your sizes",
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kit sizing</CardTitle>
        <CardDescription>
          So we can order the right gi and belt for you, and hand you the right loan gear. Both are
          optional.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="gi-size">Gi size</Label>
              <GiSizeSelect
                id="gi-size"
                value={giSize}
                onChange={setGiSize}
                disabled={busy}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                The number in brackets is the wearer's height that gi size is cut for.{" "}
                {GI_SIZE_HINT}
              </p>
            </div>
            <div>
              <Label htmlFor="belt-size">Belt size</Label>
              <BeltSizeSelect
                id="belt-size"
                value={beltSize}
                onChange={setBeltSize}
                disabled={busy}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">{BELT_SIZE_HINT}</p>
            </div>
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * How the club reaches this person, and who it calls if something happens.
 *
 * The warning in the description is not boilerplate: approving a waiver still
 * promotes that submission's contact fields onto the profile
 * (`waiverToProfileFields`), so a correction made here can be overwritten later
 * by a manager working through a backlog of older waivers.
 */
function ContactCard({ profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save } = useDetailsSave({ profile, onSaved });
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");

  // See AboutYouCard: keyed on this card's own fields, never on `profile`.
  const stored = useMemo(
    () => ({
      phone: profile?.phone ?? "",
      address: profile?.address ?? "",
      smsConsent: profile?.sms_whatsapp_consent ?? false,
      ecName: profile?.emergency_contact_name ?? "",
      ecRelationship: profile?.emergency_contact_relationship ?? "",
      ecPhone: profile?.emergency_contact_phone ?? "",
    }),
    [
      profile?.phone,
      profile?.address,
      profile?.sms_whatsapp_consent,
      profile?.emergency_contact_name,
      profile?.emergency_contact_relationship,
      profile?.emergency_contact_phone,
    ],
  );

  const revert = useMemo(
    () => () => {
      setPhone(stored.phone);
      setAddress(stored.address);
      setSmsConsent(stored.smsConsent);
      setEcName(stored.ecName);
      setEcRelationship(stored.ecRelationship);
      setEcPhone(stored.ecPhone);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const dirty =
    phone !== stored.phone ||
    address !== stored.address ||
    smsConsent !== stored.smsConsent ||
    ecName !== stored.ecName ||
    ecRelationship !== stored.ecRelationship ||
    ecPhone !== stored.ecPhone;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save(
      {
        phone: phone.trim(),
        address: address.trim(),
        sms_whatsapp_consent: smsConsent,
        emergency_contact_name: ecName.trim(),
        emergency_contact_relationship: ecRelationship.trim(),
        emergency_contact_phone: ecPhone.trim(),
      },
      "Contact details saved",
      "Could not save your contact details",
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact</CardTitle>
        <CardDescription>
          How we reach you, and who we call if something happens in class. Saving here updates our
          current record straight away. It does not change a waiver you have already signed, which
          keeps what you typed at the time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="account-phone">Mobile</Label>
              <Input
                id="account-phone"
                type="tel"
                required
                maxLength={30}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mt-1.5"
              />
              <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={smsConsent}
                  onCheckedChange={(v) => setSmsConsent(v === true)}
                  className="mt-0.5"
                  aria-label="Consent to SMS or WhatsApp contact"
                />
                <span>
                  I agree to be contacted by SMS or WhatsApp, and added to club WhatsApp groups.
                </span>
              </label>
            </div>
            <div>
              <Label htmlFor="account-address">Address</Label>
              <Input
                id="account-address"
                required
                maxLength={300}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="mt-1.5"
              />
            </div>

            <fieldset className="space-y-4 rounded-md border p-4">
              <legend className="px-1 text-sm font-medium">Emergency contact</legend>
              <div>
                <Label htmlFor="account-ec-name">Name</Label>
                <Input
                  id="account-ec-name"
                  required
                  maxLength={120}
                  value={ecName}
                  onChange={(e) => setEcName(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="account-ec-relationship">Relationship</Label>
                <Input
                  id="account-ec-relationship"
                  required
                  maxLength={80}
                  value={ecRelationship}
                  onChange={(e) => setEcRelationship(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="account-ec-phone">Mobile</Label>
                <Input
                  id="account-ec-phone"
                  type="tel"
                  required
                  maxLength={30}
                  value={ecPhone}
                  onChange={(e) => setEcPhone(e.target.value)}
                  className="mt-1.5"
                />
              </div>
            </fieldset>

            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Whether the club may use photos and video of this member.
 *
 * Its own card rather than a line in Contact: that card is about how to reach
 * somebody, and burying a consent decision under a phone number is how people
 * end up never having made one. It also needs room to say that changing it here
 * takes effect now, without contradicting the waiver they signed.
 *
 * The member owns this one. A photo consent only a manager could withdraw would
 * be the wrong way round -- they are the person in the photograph.
 *
 * Two explicit buttons rather than a checkbox: a checkbox collapses "I was
 * asked and said no" and "nobody has asked me" into the same unticked box, and
 * the whole point of this card is letting someone actively refuse, not just
 * abstain. There is no "clear back to not asked" button here -- only a manager
 * can put a record back to that state (see the mirrored card on their user
 * page), because "not asked" stops being true the moment a member looks at
 * this control.
 */
function MediaConsentCard({ profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save } = useDetailsSave({ profile, onSaved });

  // `null` on file means nobody has ever asked, or a manager cleared it back to
  // that. The status badge and explainer below always reflect THIS (the
  // record on file), not the button the member has clicked but not yet saved,
  // so a selection they have not saved never reads as already recorded.
  const stored: boolean | null = useMemo(
    () =>
      profile?.media_consent === true || profile?.media_consent === false
        ? profile.media_consent
        : null,
    [profile?.media_consent],
  );
  const [consent, setConsent] = useState<boolean | null>(null);

  const revert = useMemo(() => () => setConsent(stored), [stored]);
  useEffect(revert, [revert]);

  const dirty = consent !== null && consent !== stored;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (consent === null) return;
    await save({ media_consent: consent }, "Saved", "Could not save that");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Photos and video</CardTitle>
        <CardDescription>
          We sometimes photograph or film classes to promote the club. Tell us whether we can use
          photos or video of you, and change your mind here any time. It does not rewrite a waiver
          you have already signed, which keeps what you ticked at the time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {/* preserveCase: "Not asked" is a sentence, not an enum value. */}
              <Pill
                label={mediaConsentLabel(stored)}
                className={mediaConsentClass(stored)}
                preserveCase
              />
              <span className="text-sm text-muted-foreground">
                {stored === true
                  ? "We can use photos and video of you to promote the club. Your name is never published alongside them."
                  : stored === false
                    ? "We will not use any photo or video of you."
                    : "You have not told us either way yet. Until you do, we will ask before using anything you are in."}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={consent === true ? "default" : "outline"}
                aria-pressed={consent === true}
                onClick={() => setConsent(true)}
              >
                Yes, I consent
              </Button>
              <Button
                type="button"
                size="sm"
                variant={consent === false ? "default" : "outline"}
                aria-pressed={consent === false}
                onClick={() => setConsent(false)}
              >
                No, I don't consent
              </Button>
            </div>
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
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
      toast.error(e instanceof Error ? e.message : "Could not open the PDF. Try again.");
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
