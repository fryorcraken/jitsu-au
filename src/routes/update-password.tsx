import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SiteLayout } from "@/components/site/SiteLayout";
import { NewPasswordField } from "@/components/site/NewPasswordField";
import { describePasswordError, passwordProblem, type BreachStatus } from "@/lib/password-policy";
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

function UpdatePasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [personal, setPersonal] = useState<(string | null | undefined)[]>([]);
  const [password, setPassword] = useState("");
  const [breach, setBreach] = useState<BreachStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Supabase parses the recovery token from the URL hash automatically.
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) toast.error("Reset link is invalid or expired. Request a new one.");
      const email = data.session?.user.email ?? null;
      setPersonal([email]);
      setReady(true);
      if (!data.session) return;
      // The field promises to refuse a password built out of the person's NAME
      // as well as their address, and the recovery session only carries the
      // address. Fetch the rest so this screen enforces the list it is showing,
      // the same as /account does. Best effort and never blocking: the form is
      // already usable, and a name arriving late only tightens the check.
      try {
        const profile = await getMyProfile();
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
    });
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
            <CardTitle>Set a new password</CardTitle>
          </CardHeader>
          <CardContent>
            {ready && (
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
