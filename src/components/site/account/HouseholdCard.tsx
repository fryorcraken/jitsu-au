import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { Pill } from "@/components/site/StatusPill";
import { describeLoadError } from "@/lib/load-error";
import { lifecycleClass } from "@/lib/status-colours";
import { lifecycleLabel, membershipStatusLabel } from "@/lib/status-labels";
import { listMyHousehold, type HouseholdPerson } from "@/lib/household.functions";

/**
 * Everybody on this account, and a way through to each of them.
 *
 * The club takes children, and a parent has one login for the family. This is
 * the only screen that says so: without it a parent signs a second waiver, sees
 * nothing change on their account page, and has no way to tell whether the club
 * has one child on file or two.
 *
 * It is HIDDEN for an account with no dependants, which is almost every
 * account. "People on your account: you" is a card that tells a member nothing
 * and pushes the details they came for further down the page.
 */
export function HouseholdCard({ userId }: { userId: string }) {
  const fetchHousehold = useServerFn(listMyHousehold);
  const [people, setPeople] = useState<HouseholdPerson[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed read is not "nobody is on your account". Rendered as an empty
  // card, it would tell a parent their children are gone.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return fetchHousehold()
      .then((rows) => {
        setPeople(rows);
        setLoadError(null);
      })
      .catch((e) => {
        setPeople([]);
        setLoadError(describeLoadError(e, "Could not load the people on your account"));
      })
      .finally(() => setLoading(false));
  }, [fetchHousehold]);

  useEffect(() => {
    void load();
  }, [load]);

  const dependants = people.filter((p) => !p.is_self);
  const self = people.find((p) => p.is_self) ?? null;

  // Nothing to say, and nothing went wrong. Say nothing.
  if (loading) return null;
  if (!loadError && dependants.length === 0) return null;

  // The holder only when they have records of their own. A parent who does not
  // train has no waiver, no membership and no photo consent, so a row for them
  // would invite a click through to an empty page.
  const listed = [...(self && self.has_any_waiver ? [self] : []), ...dependants];

  return (
    <Card>
      <CardHeader>
        <CardTitle>People on your account</CardTitle>
        <CardDescription>
          Everyone you look after here. Tap a name for their waivers, membership and details.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadError ? (
          <LoadFailure
            what="The people on your account"
            message={loadError}
            hint="This is not the same as having nobody on it, so nothing has been removed."
            onRetry={() => void load()}
          />
        ) : (
          <ul className="space-y-2">
            {listed.map((person) => (
              <li key={person.user_id}>
                <Link
                  to={person.is_self ? "/account" : "/account/$userId"}
                  params={person.is_self ? undefined : { userId: person.user_id }}
                  // A whole-row target rather than a small "view" link at the
                  // end: this is read on a phone, and a name is a much easier
                  // thing to hit with a thumb than a word.
                  className="flex items-center gap-3 rounded-md border px-3 py-3 transition-colors hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{person.name || "Unnamed"}</span>
                      {person.is_self && (
                        <span className="text-xs text-muted-foreground">(you)</span>
                      )}
                      <Pill
                        label={lifecycleLabel(person.lifecycle_status, membershipOf(person))}
                        className={lifecycleClass(person.lifecycle_status)}
                        preserveCase
                      />
                    </span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {membershipLine(person)}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Button asChild variant="outline" size="sm">
          <Link to="/waiver">Add someone to this account</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The membership fields the label helpers read, or null when there is none.
 *
 * Shaped here rather than on the server so the member's card and the manager's
 * directory name a state the same way: both go through `lifecycleLabel` and
 * `membershipStatusLabel`, so "Used up" cannot mean one thing on one screen and
 * something else on the other.
 */
function membershipOf(person: HouseholdPerson) {
  if (!person.latest_membership_status || !person.latest_plan_kind) return null;
  return {
    status: person.latest_membership_status,
    kind: person.latest_plan_kind,
    sessions_remaining: person.latest_sessions_remaining,
  };
}

/** One line about where this person stands, in a parent's words. */
function membershipLine(person: HouseholdPerson): string {
  const membership = membershipOf(person);
  if (!membership || !person.latest_plan_name) {
    return person.has_any_waiver ? "No membership yet" : "No waiver signed yet";
  }
  return `${person.latest_plan_name}: ${membershipStatusLabel(membership).toLowerCase()}`;
}
