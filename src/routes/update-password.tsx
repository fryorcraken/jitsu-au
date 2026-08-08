import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SiteLayout } from "@/components/site/SiteLayout";
import { NewPasswordField } from "@/components/site/NewPasswordField";
import { describePasswordError, passwordProblem } from "@/lib/password-policy";
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
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Supabase parses the recovery token from the URL hash automatically.
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) toast.error("Reset link is invalid or expired. Request a new one.");
      // The recovery session tells us who this is, which is what lets the rules
      // refuse a password built out of their own address.
      setEmail(data.session?.user.email ?? null);
      setReady(true);
    });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Say what is wrong here rather than spending a round trip to be told.
    const local = passwordProblem(password, { personal: [email] });
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
                  onChange={setPassword}
                  personal={[email]}
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
