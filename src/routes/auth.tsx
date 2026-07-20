import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const searchSchema = z.object({
  redirect: z.string().optional(),
  mode: z.enum(["signin", "signup"]).optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Sign in | UTS Jitsu" },
      { name: "description", content: "Sign in to your UTS Jitsu account." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { redirect, mode } = useSearch({ from: "/auth" });
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: redirect ?? "/account" });
      else setReady(true);
    });
  }, [navigate, redirect]);

  if (!ready) return null;

  return (
    <SiteLayout>
      <section className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>Welcome</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={mode === "signup" ? "signup" : "signin"}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Create account</TabsTrigger>
              </TabsList>
              <TabsContent value="signin" className="pt-4">
                <SignInForms redirect={redirect} />
              </TabsContent>
              <TabsContent value="signup" className="pt-4">
                <SignUpForm />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </section>
    </SiteLayout>
  );
}

function SignInForms({ redirect }: { redirect?: string }) {
  const [view, setView] = useState<"magic" | "password">("magic");
  const [sentEmail, setSentEmail] = useState<string | null>(null);

  if (sentEmail && view === "magic") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          If <strong>{sentEmail}</strong> matches an account, we've sent a sign-in link. Check your inbox to sign in.
        </p>
        <Button type="button" variant="outline" className="w-full" onClick={() => setView("password")}>
          Login with password
        </Button>
      </div>
    );
  }

  if (view === "password") {
    return (
      <div className="space-y-3">
        <PasswordSignIn redirect={redirect} />
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setSentEmail(null);
            setView("magic");
          }}
        >
          Back to email sign-in
        </Button>
      </div>
    );
  }

  return <MagicLinkSignIn onSent={(email) => setSentEmail(email)} />;
}

function PasswordSignIn({ redirect }: { redirect?: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Signed in");
    navigate({ to: redirect ?? "/account" });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Signing in..." : "Sign in"}
      </Button>
      <div className="text-center text-sm">
        <Link to="/reset-password" className="text-primary hover:underline">
          Forgot password?
        </Link>
      </div>
    </form>
  );
}

function MagicLinkSignIn({ onSent }: { onSent: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    // Fire and forget: never surface whether the address matches an account.
    try {
      await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/account`,
          shouldCreateUser: false,
        },
      });
    } catch {
      // swallow: response must not differ for valid vs invalid emails
    }
    setBusy(false);
    onSent(email);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label htmlFor="magic-email">Email</Label>
        <Input id="magic-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Sending..." : "Sign in"}
      </Button>
    </form>
  );
}


function SignUpForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/account` },
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    setSent(true);
  }

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        Almost there. Check <strong>{email}</strong> for a confirmation link to activate your account.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label htmlFor="new-email">Email</Label>
        <Input id="new-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="new-password">Password</Label>
        <Input
          id="new-password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">At least 8 characters.</p>
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Creating account..." : "Create account"}
      </Button>
    </form>
  );
}
