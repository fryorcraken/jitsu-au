import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Loading } from "@/components/site/Loading";
import { SaveFailure } from "@/components/site/SaveFailure";
import { CodeOfConductDocument } from "@/components/site/CodeOfConductDocument";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/useAuth";
import { formatDate } from "@/lib/dates";
import { CODE_OF_CONDUCT_ACKNOWLEDGEMENT, CODE_OF_CONDUCT_VERSION } from "@/lib/code-of-conduct";
import { acceptCodeOfConduct, getCodeOfConductSigner } from "@/lib/code-of-conduct.functions";
import { codeOfConductSearchSchema } from "@/lib/validation";

export const Route = createFileRoute("/code-of-conduct")({
  // `?t=` carries the token from the "sign it later" email.
  validateSearch: codeOfConductSearchSchema,
  head: () => ({
    meta: [
      { title: "Code of conduct | UTS Jitsu" },
      {
        name: "description",
        content:
          "The rules we train by at UTS Jitsu: hygiene, mat etiquette, protective gear, respect and safety, and how to report an incident.",
      },
      { property: "og:title", content: "Code of conduct | UTS Jitsu" },
      {
        property: "og:description",
        content: "The rules we train by at UTS Jitsu, and how to report an incident.",
      },
      { property: "og:url", content: "https://jitsu.au/code-of-conduct" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/code-of-conduct" }],
  }),
  component: CodeOfConduct,
});

function CodeOfConduct() {
  const { t: token, for: subjectId } = Route.useSearch();
  const { user, loading: authLoading } = useAuth();
  const fetchSigner = useServerFn(getCodeOfConductSigner);
  const accept = useServerFn(acceptCodeOfConduct);

  const [agreed, setAgreed] = useState(false);
  const [signatureName, setSignatureName] = useState("");
  const [saving, setSaving] = useState(false);
  // Held, not toasted. A toast fades in four seconds and leaves a form that
  // looks exactly like one that filed, so somebody who glanced away walks off
  // believing the agreement is on record. That was already wrong for a member
  // signing for themselves; it is worse now that a parent can sign for a child
  // and never find out that nothing was filed.
  const [saveError, setSaveError] = useState<string | null>(null);
  // The honeypot's live value. A person never touches it (it is display:none
  // and out of the tab order), so anything in it came from something filling
  // the form in wholesale.
  const [hp, setHp] = useState("");
  const [justSigned, setJustSigned] = useState<string | null>(null);

  // Wait for auth to settle before asking: the session's bearer token is what
  // identifies a signed-in member to the server, and asking too early would
  // resolve them as "we don't know who you are" and offer them the wrong screen.
  const signerQ = useQuery({
    queryKey: ["code-of-conduct-signer", token ?? "", user?.id ?? "", subjectId ?? ""],
    queryFn: () => fetchSigner({ data: { token: token ?? "", userId: subjectId } }),
    enabled: !authLoading,
    staleTime: 60_000,
  });

  const signer = signerQ.data?.signer ?? null;
  const status = signerQ.data?.status ?? null;
  // Set only when the agreement is about somebody else on the caller's account.
  // Everything on this page that says "you" has to say their name instead, or a
  // parent cannot tell which child they are agreeing for.
  const subject = signerQ.data?.subject ?? null;
  const subjectName = subject?.greeting_name ?? subject?.name ?? null;

  // Sign with the name the club has on file, without stopping anyone correcting
  // it (a legal name and the name someone signs with are not always identical).
  useEffect(() => {
    if (signer?.full_name) setSignatureName((current) => current || signer.full_name);
  }, [signer?.full_name]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agreed) {
      toast.error("Please tick the box to say you agree.");
      return;
    }
    if (!signatureName.trim()) {
      toast.error("Please type your name to sign.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await accept({
        data: {
          token: token ?? "",
          // WHOSE agreement. Absent means the caller's own.
          userId: subjectId,
          agree: true,
          signature_name: signatureName,
          version: CODE_OF_CONDUCT_VERSION,
          client_meta: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
            screen: `${window.screen.width}x${window.screen.height}`,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            platform: navigator.platform ?? "",
            languages: [...(navigator.languages ?? [])].slice(0, 10),
          },
          hp,
        },
      });
      setJustSigned(res.accepted_at ?? new Date().toISOString());
      toast.success(
        subjectName
          ? `Thanks. That is on file for ${subjectName}.`
          : "Thanks. Your agreement is on file.",
      );
    } catch (err) {
      setSaveError(
        err instanceof Error && err.message
          ? err.message
          : "We could not file that just now. What you typed is still here, so try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-3xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Code of conduct
        </p>
        <h1 className="mt-3 text-4xl font-bold">How we train together</h1>
        <p className="mt-3 text-muted-foreground">
          Every member agrees to this. Your training waiver is the one you have to sign before your
          first session. This one is not a barrier to training, and we ask you to sign it around the
          time you join as a paying member.
        </p>

        <div className="mt-10 rounded-2xl border bg-card p-6 md:p-8">
          <CodeOfConductDocument />
          <p className="mt-8 border-t pt-4 text-xs text-muted-foreground">
            Version {CODE_OF_CONDUCT_VERSION}
          </p>
        </div>

        <div className="mt-8">
          {signerQ.isPending ? (
            <Loading />
          ) : justSigned ? (
            <SignedPanel
              name={signer?.name ?? ""}
              acceptedAt={justSigned}
              version={CODE_OF_CONDUCT_VERSION}
              signedIn={Boolean(user)}
              forName={subjectName}
            />
          ) : !signer ? (
            <NotIdentifiedPanel signedIn={Boolean(user)} />
          ) : status?.state === "signed" ? (
            <SignedPanel
              name={signer.name}
              acceptedAt={status.accepted_at ?? ""}
              version={status.accepted_version ?? CODE_OF_CONDUCT_VERSION}
              signedIn={Boolean(user)}
              forName={subjectName}
            />
          ) : (
            <form onSubmit={onSubmit} className="space-y-5 rounded-2xl border bg-card p-6 md:p-8">
              <input
                type="text"
                name="hp"
                tabIndex={-1}
                autoComplete="off"
                className="hidden"
                value={hp}
                onChange={(e) => setHp(e.target.value)}
              />
              <div>
                <h2 className="text-xl font-bold">Agree to the code</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {subjectName ? (
                    <>
                      Agreeing on behalf of <strong>{subject?.name ?? subjectName}</strong>, signed
                      by you as <strong>{signer.full_name}</strong>.
                    </>
                  ) : (
                    <>
                      Signing as <strong>{signer.full_name}</strong> ({signer.email}).
                      {signer.signed_in
                        ? " To sign for someone else, log out first."
                        : " Not you? Use the link from your own email."}
                    </>
                  )}
                </p>
                {status?.state === "outdated" && (
                  <p className="mt-3 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary">
                    {subjectName ? `Agreed for ${subjectName}` : "You agreed"} to version{" "}
                    {status.accepted_version} on {formatDate(status.accepted_at ?? "")}. We have
                    updated it since, so please read it again and agree to version{" "}
                    {CODE_OF_CONDUCT_VERSION}.
                  </p>
                )}
              </div>

              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={agreed}
                  onCheckedChange={(v) => {
                    setAgreed(v === true);
                    setSaveError(null);
                  }}
                  className="mt-0.5"
                />
                <span>{CODE_OF_CONDUCT_ACKNOWLEDGEMENT}</span>
              </label>

              <div>
                <Label htmlFor="signature_name">Type your name to sign</Label>
                <Input
                  id="signature_name"
                  required
                  maxLength={120}
                  value={signatureName}
                  onChange={(e) => {
                    setSignatureName(e.target.value);
                    // The panel described the last attempt; editing the form
                    // under it would leave it claiming something it never saw.
                    setSaveError(null);
                  }}
                  placeholder="Your full name"
                  className="mt-1.5"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  By submitting this form you agree it counts as an electronic signature dated{" "}
                  {new Date().toLocaleDateString("en-AU")}.
                </p>
              </div>

              {saveError && (
                <SaveFailure
                  what={subjectName ? `${subjectName}'s agreement` : "Your agreement"}
                  message={saveError}
                  onRetry={() =>
                    void onSubmit({ preventDefault: () => {} } as React.FormEvent<HTMLFormElement>)
                  }
                  retrying={saving}
                />
              )}

              <Button type="submit" size="lg" disabled={saving} className="w-full sm:w-auto">
                {saving
                  ? "Saving..."
                  : subjectName
                    ? `Agree on behalf of ${subjectName}`
                    : "Agree to the code of conduct"}
              </Button>
            </form>
          )}
        </div>
      </section>
    </SiteLayout>
  );
}

function SignedPanel({
  name,
  acceptedAt,
  version,
  signedIn,
  forName,
}: {
  name: string;
  acceptedAt: string;
  version: number;
  signedIn: boolean;
  /** Set when this records somebody else's agreement, not the reader's own. */
  forName?: string | null;
}) {
  return (
    <div className="rounded-2xl border bg-card p-6 md:p-8">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-6 w-6 flex-none text-primary" />
        <div>
          <h2 className="text-xl font-bold">
            {forName
              ? `That is on file for ${forName}`
              : `You're all set${name ? `, ${name}` : ""}`}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {forName ? `${forName} is agreed to` : "You agreed to"} version {version} of the code of
            conduct
            {acceptedAt ? ` on ${formatDate(acceptedAt)}` : ""}. There is nothing else to do. If we
            change the rules, we will ask you to read them again.
          </p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link to={signedIn ? "/account" : "/"}>
            {signedIn ? "Back to your account" : "Back home"}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/classes">See classes</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Nobody could be identified: no session, and no usable link.
 *
 * Deliberately says nothing about whether any particular person exists or
 * whether a link was ever valid. An expired token, a link for an address the
 * club has since corrected, and a plain visit to the page all land here.
 */
function NotIdentifiedPanel({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="rounded-2xl border bg-muted/30 p-6 md:p-8">
      <h2 className="text-xl font-bold">Ready to agree to it?</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {signedIn
          ? "We could not match this page to your membership record. Sign your training waiver first and we will send you a link to come back here."
          : "Use the button in the email we sent when you signed your waiver, or sign in and agree from your account page."}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {!signedIn && (
          <Button asChild>
            <Link to="/auth" search={{ redirect: "/code-of-conduct" }}>
              Sign in
            </Link>
          </Button>
        )}
        <Button asChild variant="outline">
          <Link to="/waiver">Sign the training waiver</Link>
        </Button>
      </div>
    </div>
  );
}
