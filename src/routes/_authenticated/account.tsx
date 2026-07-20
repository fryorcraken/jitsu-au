import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({
    meta: [
      { title: "Your account | UTS Jitsu" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { roles, isManager } = useRoles(user?.id);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  if (!user) return null;

  return (
    <SiteLayout>
      <section className="mx-auto max-w-2xl space-y-6 px-4 py-12">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black">Your account</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Signed in as <strong>{user.email}</strong>
              {roles.length > 0 && (
                <> · Roles: {roles.join(", ")}</>
              )}
            </p>
          </div>
          <Button variant="outline" onClick={signOut}>Sign out</Button>
        </div>

        {isManager && (
          <Card>
            <CardHeader>
              <CardTitle>Manager tools</CardTitle>
              <CardDescription>Waiver template and signed waivers.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild variant="outline"><Link to="/manager/waiver-template">Edit waiver template</Link></Button>
              <Button asChild variant="outline"><Link to="/manager/waivers">View signed waivers</Link></Button>
            </CardContent>
          </Card>
        )}

        <ChangePasswordCard />
        <ChangeEmailCard currentEmail={user.email ?? ""} />
      </section>
    </SiteLayout>
  );
}

function ChangePasswordCard() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return toast.error(error.message);
    setPassword("");
    toast.success("Password updated");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="cp">New password</Label>
            <Input
              id="cp"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>{busy ? "Saving..." : "Update password"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangeEmailCard({ currentEmail }: { currentEmail: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => setEmail(currentEmail), [currentEmail]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (email === currentEmail) return;
    setBusy(true);
    const { error } = await supabase.auth.updateUser(
      { email },
      { emailRedirectTo: `${window.location.origin}/account` },
    );
    setBusy(false);
    if (error) return toast.error(error.message);
    setPending(true);
    toast.success("Confirmation emails sent to both addresses");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change email</CardTitle>
        <CardDescription>
          You'll receive a confirmation link at both your current and new email address.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="ce">Email</Label>
            <Input id="ce" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button type="submit" disabled={busy || email === currentEmail}>
            {busy ? "Sending..." : "Update email"}
          </Button>
          {pending && (
            <p className="text-sm text-muted-foreground">
              Change pending. Confirm from both inboxes to complete.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
