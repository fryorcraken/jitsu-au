// The settings panel a person reaches from the foot of a notification email:
// /email-settings
//
// No token in this URL. `/email-settings/<token>` exchanges the emailed link for
// a short-lived cookie and sends the browser here, so the credential is never in
// the address bar, the history, or anything anybody pastes. What the cookie is
// and why it is set the way it is: src/lib/email-settings-session.ts.
//
// The response is deliberately UNIFORM. No cookie, an expired one, a rotated
// token and a token that never existed all produce the same screen. Anything
// else would make this page a way to probe which links the club has issued, and
// the visitor has nothing useful to do with the difference anyway.
//
// This is a settings PANEL, not a one-click unsubscribe. Somebody who only
// wanted fewer announcements should not lose replies as well, which is what a
// single "you are unsubscribed from everything" button would cost them.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { SiteLayout } from "@/components/site/SiteLayout";
import { Loading } from "@/components/site/Loading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NotificationSwitches } from "@/components/site/NotificationSwitches";
import { buildPageMeta } from "@/lib/seo";
import type { EmailPreferenceKey } from "@/lib/notifications";
import {
  getEmailSettingsPreferences,
  saveEmailSettingsPreferences,
} from "@/lib/notifications.functions";

export const Route = createFileRoute("/email-settings/")({
  // Never indexable. It is one person's settings, reached with a credential a
  // crawler does not hold, and a search result pointing at it would be a dead
  // end for everybody who clicked it.
  head: () => ({
    meta: [
      ...buildPageMeta({
        title: "Email settings | UTS Jitsu",
        description: "Choose what UTS Jitsu emails you.",
        path: "/email-settings",
      }),
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/email-settings" }],
  }),
  // No SSR. Nothing about one person's settings should travel through a server
  // render into HTML that might be held anywhere along the way.
  ssr: false,
  component: EmailSettingsPage,
});

/**
 * What the page is showing.
 *
 * `gone` and `lapsed` are the same fact arriving at two different moments, and
 * they get different words for it. Somebody who lands on `gone` never got in;
 * somebody who hits `lapsed` was reading their own switches a minute ago and
 * needs to be told the session ran out rather than that their link is broken.
 */
type PageState = "loading" | "ready" | "gone" | "lapsed";

function SignInCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link to="/notifications">Sign in and open notifications</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function EmailSettingsPage() {
  const load = useServerFn(getEmailSettingsPreferences);
  const save = useServerFn(saveEmailSettingsPreferences);

  const [prefs, setPrefs] = useState<Record<EmailPreferenceKey, boolean> | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [saving, setSaving] = useState(false);
  // A save that could not reach us, kept on screen with the switch it was for.
  // Not a toast: a toast fades, and somebody who thinks they turned emails off
  // and did not will find out from their inbox a week later.
  const [failed, setFailed] = useState<{ key: EmailPreferenceKey; next: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    load({})
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setPrefs(result.preferences);
          setState("ready");
        } else {
          setState("gone");
        }
      })
      // A failed request and an unknown token land in the same place on
      // purpose. See the uniform-response note at the top of this file.
      .catch(() => {
        if (live) setState("gone");
      });
    return () => {
      live = false;
    };
  }, [load]);

  const applySwitch = useCallback(
    (key: EmailPreferenceKey, next: boolean) => {
      // Optimistic. A switch that waits for a round trip before it moves feels
      // broken, so it moves now and goes back if the save does not land.
      const previous = prefs;
      setPrefs((p) => (p ? { ...p, [key]: next } : p));
      setSaving(true);
      setFailed(null);
      save({ data: { [key]: next } })
        .then((result) => {
          if (result.ok) {
            setPrefs(result.preferences);
            return;
          }
          // The cookie ran out (or was replaced) while this page sat open.
          // Nothing further on this page will work, so say so rather than
          // letting them flip switches into the void.
          setPrefs(previous);
          setState("lapsed");
        })
        .catch(() => {
          setPrefs(previous);
          setFailed({ key, next });
        })
        .finally(() => setSaving(false));
    },
    [prefs, save],
  );

  const retry = useCallback(() => {
    if (failed) applySwitch(failed.key, failed.next);
  }, [applySwitch, failed]);

  return (
    <SiteLayout>
      <section className="mx-auto max-w-2xl space-y-6 px-4 py-16">
        <div>
          <h1 className="text-3xl font-black">Email settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose what UTS Jitsu emails you. No need to sign in.
          </p>
        </div>

        {state === "loading" && <Loading label="Loading your email settings..." />}

        {state === "gone" && (
          <SignInCard title="This link is no longer live">
            A settings link stops working after a while, and each new email brings a fresh one. Open
            the most recent email we sent you, or sign in and change everything from your
            notifications page.
          </SignInCard>
        )}

        {state === "lapsed" && (
          <SignInCard title="This page has been open too long">
            We keep these links usable for half an hour, so nobody else can pick up where you left
            off. Nothing you changed before now is lost. Open the link at the bottom of any email
            from us to carry on, or sign in and use your notifications page.
          </SignInCard>
        )}

        {state === "ready" && prefs && (
          <Card>
            <CardHeader>
              <CardTitle>What we email you</CardTitle>
              <CardDescription>Changes save as you make them.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* No manager switch here. This page cannot tell whether the
                  person holds the role without a session, and offering a
                  manager-only choice to a member would be a lie about what
                  they can turn on. Managers have the full set on
                  /notifications. */}
              <NotificationSwitches values={prefs} onChange={applySwitch} disabled={saving} />

              {failed && (
                <div
                  className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
                  role="alert"
                >
                  <p className="flex items-start gap-2 text-sm font-medium">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    We couldn't save that change.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The switch is back where it was, so nothing has changed. Check your signal and
                    try again.
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={retry}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
                  </Button>
                </div>
              )}

              {saving && <Loading label="Saving..." />}
            </CardContent>
          </Card>
        )}
      </section>
    </SiteLayout>
  );
}
