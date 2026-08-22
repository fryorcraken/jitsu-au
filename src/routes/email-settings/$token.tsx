// The settings panel at the bottom of every notification email:
// /email-settings/<token>
//
// The token rides in the URL path because an email client cannot send an
// Authorization header, exactly like the per-person calendar feed at
// /api/calendar/<token> and the verification landing at /api/verify-email/
// <token>.
//
// Deliberately NOT under /notifications/<token>: that path already belongs to
// the signed-in page inside the `_authenticated` group, and two routes claiming
// the same prefix is a collision waiting to be debugged at three in the morning.
//
// The response is deliberately UNIFORM. A token that never existed, one that has
// been rotated, and a malformed one all render the same panel-less page. Doing
// otherwise would make this endpoint a way to probe which links the club has
// issued, and the visitor has nothing useful to do with the difference anyway.
//
// This is a settings PANEL, not a one-click unsubscribe. Somebody who only
// wanted fewer announcements should not lose replies as well, which is what a
// single "you are unsubscribed from everything" button would cost them.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { SiteLayout } from "@/components/site/SiteLayout";
import { Loading } from "@/components/site/Loading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NotificationSwitches } from "@/components/site/NotificationSwitches";
import type { EmailPreferenceKey } from "@/lib/notifications";
import {
  getNotificationPreferencesByToken,
  saveNotificationPreferencesByToken,
} from "@/lib/notifications.functions";

export const Route = createFileRoute("/email-settings/$token")({
  // Never indexable: the path contains a credential, and a crawler that reached
  // one would put somebody's settings link in a search result.
  head: () => ({
    meta: [
      { title: "Email settings | UTS Jitsu" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  // No SSR: the token should not travel through a server render into the HTML
  // payload of a page that might be cached anywhere along the way.
  ssr: false,
  component: EmailSettingsPage,
});

function EmailSettingsPage() {
  const { token } = Route.useParams();
  const load = useServerFn(getNotificationPreferencesByToken);
  const save = useServerFn(saveNotificationPreferencesByToken);

  const [prefs, setPrefs] = useState<Record<EmailPreferenceKey, boolean> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load({ data: { token } })
      .then((result) => {
        if (result.ok) {
          setPrefs(result.preferences);
          setState("ready");
        } else {
          setState("unavailable");
        }
      })
      // A failed request and an unknown token land in the same place on
      // purpose. See the uniform-response note at the top of this file.
      .catch(() => setState("unavailable"));
  }, [load, token]);

  const onSwitch = useCallback(
    (key: EmailPreferenceKey, next: boolean) => {
      const previous = prefs;
      setPrefs((p) => (p ? { ...p, [key]: next } : p));
      setSaving(true);
      save({ data: { token, [key]: next } })
        .then((result) => {
          if (result.ok) setPrefs(result.preferences);
          else {
            setPrefs(previous);
            setState("unavailable");
          }
        })
        .catch(() => {
          setPrefs(previous);
          toast.error("Could not save that. Try again in a moment.");
        })
        .finally(() => setSaving(false));
    },
    [prefs, save, token],
  );

  return (
    <SiteLayout>
      <section className="mx-auto max-w-2xl space-y-6 px-4 py-16">
        <div>
          <h1 className="text-3xl font-black">Email settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose what UTS Jitsu emails you. No need to sign in.
          </p>
        </div>

        {state === "loading" && <Loading />}

        {state === "unavailable" && (
          <Card>
            <CardHeader>
              <CardTitle>This link is no longer live</CardTitle>
              <CardDescription>
                It may have been replaced by a newer one. You can still change everything from your
                notifications page once you are signed in.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link to="/notifications">Sign in and open notifications</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {state === "ready" && prefs && (
          <Card>
            <CardHeader>
              <CardTitle>What we email you</CardTitle>
              <CardDescription>Changes save as you make them.</CardDescription>
            </CardHeader>
            <CardContent>
              {/* No manager switch here. This page cannot tell whether the
                  person holds the role without a session, and offering a
                  manager-only choice to a member would be a lie about what
                  they can turn on. Managers have the full set on
                  /notifications. */}
              <NotificationSwitches values={prefs} onChange={onSwitch} disabled={saving} />
            </CardContent>
          </Card>
        )}
      </section>
    </SiteLayout>
  );
}
