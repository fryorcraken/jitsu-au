import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { SiteLayout } from "@/components/site/SiteLayout";
import { NewPasswordField } from "@/components/site/NewPasswordField";
import {
  describePasswordError,
  isMissingSessionError,
  passwordProblem,
  type BreachStatus,
} from "@/lib/password-policy";
import { getMyProfile } from "@/lib/waiver.functions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/update-password")({
  head: () => ({
    meta: [{ title: "Set new password | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: UpdatePasswordPage,
});

/**
 * Whether the link this page was opened with actually got us a session.
 *
 * `expired` covers every way of arriving without one: a link that has timed
 * out, one that was already used, and the page opened on its own. They all
 * come down to the same thing for the person in front of it, and it is not a
 * thing a toast can carry, because the answer is to go and get another link.
 */
type LinkState = "checking" | "expired" | "ready";

function UpdatePasswordPage() {
  const navigate = useNavigate();
  const [link, setLink] = useState<LinkState>("checking");
  const [personal, setPersonal] = useState<(string | null | undefined)[]>([]);
  const [password, setPassword] = useState("");
  const [breach, setBreach] = useState<BreachStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let adopted = false;

    async function adopt(session: Session) {
      if (adopted || cancelled) return;
      adopted = true;
      const email = session.user.email ?? null;
      setPersonal([email]);
      setLink("ready");
      // The field promises to refuse a password built out of the person's NAME
      // as well as their address, and the recovery session only carries the
      // address. Fetch the rest so this screen enforces the list it is showing,
      // the same as /account does. Best effort and never blocking: the form is
      // already usable, and a name arriving late only tightens the check.
      try {
        const profile = await getMyProfile();
        if (cancelled) return;
        setPersonal([
          email,
          profile?.first_name,
          profile?.middle_name,
          profile?.last_name,
          profile?.preferred_name,
        ]);
      } catch {
        // Leave the email-only check in place. Supabase still has the last word.
      }
    }

    // Supabase parses the recovery token from the URL hash automatically, and
    // it can land a beat after mount. Since the form is gated on the session
    // now, a late arrival has to take the expired panel back off the screen
    // rather than leave somebody looking at it holding a link that works.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) void adopt(session);
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled || adopted) return;
      if (data.session) return void adopt(data.session);
      setLink("expired");
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Say what is wrong here rather than spending a round trip to be told.
    const local = passwordProblem(password, { personal, breach });
    if (local) return setProblem(local);
    setProblem(null);
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    // A session can lapse between opening the link and pressing the button.
    // Nothing typed into this form will save now, so hand back the way out
    // instead of an alert sitting above a form that is finished.
    if (error && isMissingSessionError(error.message)) return setLink("expired");
    // Not a toast: this stops somebody, so it has to still be on screen while
    // they fix it, next to the rules it is about.
    if (error) return setProblem(describePasswordError(error.message));
    toast.success("Password updated");
    navigate({ to: "/account" });
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            {/* The heading has to agree with the panel under it: "Set a new
                password" over "that link has expired" reads as a page arguing
                with itself, to somebody who is already locked out. */}
            <CardTitle>
              {link === "expired" ? "Reset link expired" : "Set a new password"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {link === "checking" && (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Checking your link...
              </p>
            )}

            {link === "expired" && (
              <div
                className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
                role="alert"
              >
                <p className="text-sm font-medium">That reset link has expired.</p>
                <p className="text-sm text-muted-foreground">
                  Reset links stop working after a while, and each one only works once. Ask for a
                  fresh one and check your inbox.
                </p>
                <Button asChild size="sm">
                  <Link to="/reset-password">Send me a new link</Link>
                </Button>
                <p className="text-sm text-muted-foreground">
                  Rather skip the password?{" "}
                  <Link to="/auth" className="underline underline-offset-4">
                    Sign in with an emailed link
                  </Link>{" "}
                  instead.
                </p>
              </div>
            )}

            {link === "ready" && (
              <form onSubmit={onSubmit} className="space-y-4">
                <NewPasswordField
                  id="new-pw"
                  label="New password"
                  autoFocus
                  disabled={busy}
                  value={password}
                  // Clear the refusal as soon as they start fixing it. A red
                  // panel sitting under rules that have since gone green is
                  // worse than no panel.
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
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? "Updating..." : "Update password"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </section>
    </SiteLayout>
  );
}
