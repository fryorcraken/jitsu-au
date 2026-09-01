import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { Pill } from "@/components/site/StatusPill";
import { AboutYouCard } from "@/components/site/account/AboutYouCard";
import { CodeOfConductCard } from "@/components/site/account/CodeOfConductCard";
import { ContactCard } from "@/components/site/account/ContactCard";
import type { Profile } from "@/components/site/account/DetailsCard";
import { subjectVoice } from "@/lib/subject-voice";
import { KitSizingCard } from "@/components/site/account/KitSizingCard";
import { MediaConsentCard } from "@/components/site/account/MediaConsentCard";
import { WaiversCard } from "@/components/site/account/WaiversCard";
import { useAuth } from "@/hooks/useAuth";
import { describeLoadError } from "@/lib/load-error";
import { greetingName, nameWithPreferred } from "@/lib/validation";
import { lifecycleClass } from "@/lib/status-colours";
import { lifecycleLabel } from "@/lib/status-labels";
import { listMyHousehold, type HouseholdPerson } from "@/lib/household.functions";
import { getMyProfile } from "@/lib/waiver.functions";

export const Route = createFileRoute("/_authenticated/account_/$userId")({
  head: () => ({
    meta: [
      // Deliberately not the person's name. A title is written into browser
      // history, read aloud by a screen reader in a room, and shown in a tab a
      // phone hands to whoever picks it up. None of those need a child's name.
      { title: "Someone on your account | UTS Jitsu" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PersonPage,
});

/**
 * One person on the caller's account: a child, in every case the club has.
 *
 * Built from the same cards `/account` uses, which have taken a `userId` since
 * #110 and a `voice` since #106, so a parent reads "About Bea" and "Bea's
 * waiver history" rather than a second person "you" that means their child.
 *
 * ⚠️ Every gate here is on the SERVER. `getMyProfile`, `listMyWaivers`,
 * `updateMyProfile`, `getWaiverPdfUrl` and `getCodeOfConductSigner` each run
 * `assertActingFor` on the id they are given, so this route is not a security
 * boundary and must not grow into one. What it does have to get right is the
 * REFUSAL: reaching somebody else's child has to look exactly like reaching a
 * uuid that is not a person, or the address bar becomes a way to ask the club
 * who exists. That is why the copy below repeats `household.ts`'s own sentence
 * and never says "no such person".
 */
function PersonPage() {
  const { userId } = Route.useParams();
  const { user } = useAuth();
  const fetchProfile = useServerFn(getMyProfile);
  const fetchHousehold = useServerFn(listMyHousehold);

  const [profile, setProfile] = useState<Profile>(null);
  const [person, setPerson] = useState<HouseholdPerson | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed read is NOT "you may not see this person", and it is not "this
  // person has no details" either. Conflating the first would tell a parent on
  // bad reception that their child is not theirs; conflating the second would
  // render the cards editable and empty, and one Save would write those blanks
  // over a record that was there all along.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  const load = useCallback(() => {
    if (!user?.id) return;
    setLoading(true);
    setLoadError(null);
    setRefused(false);
    Promise.all([fetchProfile({ data: { userId } }), fetchHousehold()])
      .then(([p, household]) => {
        setProfile(p);
        setPerson(household.find((h) => h.user_id === userId) ?? null);
      })
      .catch((e) => {
        setProfile(null);
        setPerson(null);
        // The gate's own sentence, matched rather than parsed for a code: it is
        // the one message `assertActingFor` gives for every no, deliberately,
        // and treating it as a refusal here keeps that single answer intact all
        // the way to the screen.
        const message = e instanceof Error ? e.message : "";
        if (message.includes("only see or change your own account")) setRefused(true);
        else setLoadError(describeLoadError(e, "Could not load this person"));
      })
      .finally(() => setLoading(false));
  }, [fetchProfile, fetchHousehold, userId, user?.id]);

  useEffect(load, [load]);

  if (!user?.id) return null;

  const name = profile ? nameWithPreferred(profile) : (person?.name ?? "");
  const first = profile ? greetingName(profile) : (person?.greeting_name ?? "");
  // ⚠️ The fallback is "this person", never the second person. `subjectVoice("")`
  // returns the SELF voice, which is the safe answer on a card that might be
  // about the reader; it is the wrong answer on a page that is definitionally
  // about somebody else. With no name on file it rendered "you has no
  // membership yet", and flipped every heading on the page ("Your details",
  // "Your records") to describe the reader while showing a child's record.
  const voice = subjectVoice(first || name || "this person");
  const details = { userId, voice, profile, loading, onSaved: setProfile };

  const backToAccount = (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to="/account">
        <ChevronLeft className="mr-1 h-4 w-4" />
        Back to your account
      </Link>
    </Button>
  );

  if (loading) {
    return (
      <section className="mx-auto max-w-2xl space-y-6 px-4 py-12">
        {backToAccount}
        <Loading />
      </section>
    );
  }

  // The refusal. Exactly the same screen for somebody else's child, for a
  // stranger's account, and for a uuid that is nobody, so this page cannot be
  // used to find out which of those a given id is.
  if (refused) {
    return (
      <section className="mx-auto max-w-2xl space-y-6 px-4 py-12">
        {backToAccount}
        <Card>
          <CardHeader>
            <CardTitle>We can&apos;t show you this page</CardTitle>
            <CardDescription>
              You can only see or change your own account and the people on it. If this should be
              one of them, ask us and we will sort it out.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/account">Back to your account</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="mx-auto max-w-2xl space-y-6 px-4 py-12">
        {backToAccount}
        <LoadFailure
          what="This person"
          message={loadError}
          hint="Nothing has changed, and nothing is lost. This is usually a dropped connection."
          onRetry={() => void load()}
        />
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      {backToAccount}

      <div>
        <h1 className="text-3xl font-black">{name || "Someone on your account"}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>On your account</span>
          {person && (
            <Pill
              label={lifecycleLabel(person.lifecycle_status, membershipOf(person))}
              className={lifecycleClass(person.lifecycle_status)}
              preserveCase
            />
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Membership</CardTitle>
          <CardDescription>
            {person?.latest_plan_name
              ? `${voice.Whose} current plan is ${person.latest_plan_name}. Pick a new one or renew.`
              : `${voice.who} has no membership yet. Pick a plan to get started.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            {/* Opens the plan picker already set to this person, so a parent
                buying for a second child cannot end up buying for the first. */}
            <Link to="/membership" search={{ for: userId }}>
              Manage {voice.whose} membership
            </Link>
          </Button>
        </CardContent>
      </Card>

      <SectionHeading>{voice.Whose} details</SectionHeading>

      <AboutYouCard {...details} />
      <KitSizingCard {...details} />
      <ContactCard {...details} />
      <MediaConsentCard {...details} />

      <p className="text-xs text-muted-foreground">
        {voice.Whose} legal name and date of birth are not editable here, because a signed waiver
        records them as they were given. Ask us and we will correct them.
      </p>

      <SectionHeading>{voice.Whose} records</SectionHeading>

      <WaiversCard userId={userId} voice={voice} />
      <CodeOfConductCard userId={userId} voice={voice} />
    </section>
  );
}

/** Mirrors `/account`, so the two pages read as one place. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="pt-4 text-xs font-bold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/** The membership fields the label helpers read, or null when there is none. */
function membershipOf(person: HouseholdPerson) {
  if (!person.latest_membership_status || !person.latest_plan_kind) return null;
  return {
    status: person.latest_membership_status,
    kind: person.latest_plan_kind,
    sessions_remaining: person.latest_sessions_remaining,
  };
}
