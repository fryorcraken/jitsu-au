import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rememberSession } from "@/lib/auth-persistence";
import { PasswordInput } from "@/components/site/PasswordInput";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInForms({ redirect }: { redirect?: string }) {
  const [view, setView] = useState<"magic" | "password">("magic");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  if (sent && view === "magic") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          If <strong>{email}</strong> matches an account, we've sent a sign-in link. Check your
          inbox to sign in.
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => setView("password")}
        >
          Login with password
        </Button>
        {/* The address stays in state, so someone who mistyped it lands back on
            the form with it prefilled and fixes the typo in one edit. */}
        <p className="text-center text-sm">
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setSent(false)}
          >
            Use a different email
          </button>
        </p>
      </div>
    );
  }

  if (view === "password") {
    return (
      <div className="space-y-3">
        <PasswordSignIn redirect={redirect} email={email} />
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setSent(false);
            setView("magic");
          }}
        >
          Back to email sign-in
        </Button>
      </div>
    );
  }

  return <MagicLinkSignIn email={email} onEmailChange={setEmail} onSent={() => setSent(true)} />;
}

function PasswordSignIn({ redirect, email }: { redirect?: string; email: string }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    // Record the choice before sign-in so the session that follows is governed
    // by the "remember me" preference from the moment it is persisted.
    rememberSession(remember);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Signed in");
    navigate({ to: redirect ?? "/account" });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Signing in as <strong>{email}</strong>
      </p>
      <div>
        <Label htmlFor="password">Password</Label>
        <PasswordInput
          id="password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="remember"
          checked={remember}
          onCheckedChange={(value) => setRemember(value === true)}
        />
        <Label htmlFor="remember" className="cursor-pointer text-sm font-normal">
          Keep me signed in
        </Label>
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

function MagicLinkSignIn({
  email,
  onEmailChange,
  onSent,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onSent: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
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
    onSent();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label htmlFor="magic-email">Email</Label>
        <Input
          id="magic-email"
          type="email"
          required
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Sending..." : "Sign in"}
      </Button>
    </form>
  );
}
