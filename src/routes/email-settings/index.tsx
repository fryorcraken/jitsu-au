// The settings panel a person reaches from the foot of a notification email:
// /email-settings
//
// No token in this URL. `/email-settings/<token>` exchanges the emailed link for
// a short-lived cookie and sends the browser here, so the credential is never in
// the address bar, the history, or anything anybody pastes. What the cookie is
// and why it is set the way it is: src/lib/email-settings-session.ts.
//
// The UNIFORM response is about the token and only the token: no cookie, an
// expired one, a rotated one and one that never existed all produce the same
// screen, because anything else would make this page a way to probe which links
// the club has issued. A dropped connection is NOT that, and must not be dressed
// up as it: telling somebody on bad reception that their link is dead sends them
// hunting for a newer email that will fail in exactly the same way. So a request
// that never landed gets `LoadFailure` and a retry, like every other screen here.
//
// This is a settings PANEL, not a one-click unsubscribe. Somebody who only
// wanted fewer announcements should not lose replies as well, which is what a
// single "you are unsubscribed from everything" button would cost them.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";

import { SiteLayout } from "@/components/site/SiteLayout";
import { Loading } from "@/components/site/Loading";
import { LoadFailure } from "@/components/site/LoadFailure";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NotificationSwitches } from "@/components/site/NotificationSwitches";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { buildPageMeta } from "@/lib/seo";
import type { EmailPreferenceKey } from "@/lib/notifications";
import {
  getEmailSettingsPreferences,
  saveEmailSettingsPreferences,
  type TokenSettings,
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
  // render into HTML that might be held anywhere along the way. The `head()`
  // above still renders server-side, so the `noindex` reaches a crawler.
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
 * `failed` is neither: the request itself did not land, and the answer to that
 * is a retry, not an explanation.
 */
type PageState = "loading" | "ready" | "gone" | "lapsed" | "failed";

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
  // The same retry driver every writing form on this site uses. It brings the
  // timeout, the automatic retries, the offline state and a failure panel that
  // stays on screen with a button in it.
  //
  // No `client_submission_id` and no `confirm`, which the intake forms need and
  // this does not: a save here sets a named switch to a named value, so sending
  // it twice lands on the same row with the same value. There is nothing a
  // duplicate could create.
  const send = useResilientSubmit<TokenSettings>(INTAKE_SUBMIT);

  const [prefs, setPrefs] = useState<Record<EmailPreferenceKey, boolean> | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  // The switch a failed save was for, so "Try again" resends that same change
  // rather than needing the person to find it and flip it a second time.
  const pending = useRef<{ key: EmailPreferenceKey; next: boolean } | null>(null);

  const runLoad = useCallback(
    (isCancelled: () => boolean = () => false) => {
      setState("loading");
      setLoadError(null);
      return load({})
        .then((result) => {
          if (isCancelled()) return;
          if (result.ok) {
            setPrefs(result.preferences);
            setState("ready");
          } else {
            setState("gone");
          }
        })
        .catch((e: unknown) => {
          if (isCancelled()) return;
          // Not "your link is dead". See the note at the top of this file.
          setLoadError(e instanceof Error ? e.message : null);
          setState("failed");
        });
    },
    [load],
  );

  useEffect(() => {
    let cancelled = false;
    void runLoad(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [runLoad]);

  const applySwitch = useCallback(
    async (key: EmailPreferenceKey, next: boolean) => {
      pending.current = { key, next };
      // Optimistic. A switch that waits for a round trip before it moves feels
      // broken, so it moves now and goes back if the save does not land.
      const previous = prefs;
      setPrefs((p) => (p ? { ...p, [key]: next } : p));

      const outcome = await send.submit({
        run: (signal) => save({ signal, data: { [key]: next } }),
      });

      if (!outcome.ok) {
        // Every attempt is spent and we never heard back, so we do not know
        // whether the last one landed. Show the last value we were actually
        // told about and let `SubmitStatus` say the rest.
        setPrefs(previous);
        return;
      }
      if (outcome.value.ok) {
        pending.current = null;
        setPrefs(outcome.value.preferences);
        return;
      }
      // The cookie ran out, or was replaced, while this page sat open. Nothing
      // further on this page will work, so say so rather than letting them flip
      // switches into the void.
      pending.current = null;
      setPrefs(previous);
      setState("lapsed");
    },
    [prefs, save, send],
  );

  const retrySave = useCallback(() => {
    const again = pending.current;
    if (again) void applySwitch(again.key, again.next);
  }, [applySwitch]);

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

        {state === "failed" && (
          <LoadFailure
            what="Your email choices"
            message={loadError}
            hint="This is not the same as your link having expired. Nothing has changed."
            onRetry={() => void runLoad()}
          />
        )}

        {state === "gone" && (
          <SignInCard title="This link is no longer live">
            A settings link stops working once it has been replaced, and each new email brings a
            fresh one. Open the most recent email we sent you, or sign in and change everything from
            your notifications page.
          </SignInCard>
        )}

        {state === "lapsed" && (
          <SignInCard title="This page has been open too long">
            This page stops saving after a while, so it does not sit open on a borrowed screen.
            Nothing you changed before now is lost. Open the link at the bottom of any email from us
            to carry on, or sign in and use your notifications page.
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
              <NotificationSwitches
                values={prefs}
                onChange={(key, next) => void applySwitch(key, next)}
                disabled={send.busy}
              />

              <SubmitStatus
                status={send.status}
                attempt={send.attempt}
                attempts={send.attempts}
                error={send.error}
                failureKind={send.failureKind}
                onRetry={retrySave}
                fallback={
                  <p className="text-sm text-muted-foreground">
                    We could not confirm that one, so it may or may not have saved. The switch shows
                    the last setting we know about. Try again and we will set it either way.
                  </p>
                }
              />
            </CardContent>
          </Card>
        )}
      </section>
    </SiteLayout>
  );
}
