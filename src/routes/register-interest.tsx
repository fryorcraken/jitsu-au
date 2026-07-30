import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ChevronDown, FileSignature } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { composeFullName } from "@/lib/validation";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { submitInterest } from "@/lib/submissions.functions";

export const Route = createFileRoute("/register-interest")({
  head: () => ({
    meta: [
      { title: "Start your free trial | UTS Jitsu" },
      {
        name: "description",
        content:
          "Start your free trial at UTS Jitsu. Tell us who you are and we'll get you on the mat. Your first two classes are free.",
      },
      { property: "og:title", content: "Start your free trial | UTS Jitsu" },
      {
        property: "og:description",
        content: "Tell us who you are and we'll get you on the mat. First two classes free.",
      },
      { property: "og:url", content: "https://jitsu.au/register-interest" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/register-interest" }],
  }),
  component: RegisterInterest,
});

type Captured = { firstName: string; lastName: string; email: string; phone: string };

function RegisterInterest() {
  const submit = useServerFn(submitInterest);
  const [showNote, setShowNote] = useState(false);
  const [done, setDone] = useState<Captured | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const send = useResilientSubmit<{ ok: true; duplicate: boolean }>(INTAKE_SUBMIT);

  /**
   * Read the form and send it, retrying through a bad connection.
   *
   * The inputs are uncontrolled, so reading the live form here is also what
   * makes "Try again" work without threading any state through: whatever is on
   * screen is what gets sent, and a failure leaves every field exactly as it
   * was. Automatic retries within one call reuse this snapshot, which is right:
   * they are resending the same submission.
   */
  async function send0() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const firstName = String(fd.get("first_name") || "").trim();
    const lastName = String(fd.get("last_name") || "").trim();
    const email = String(fd.get("email") || "");
    const phone = String(fd.get("phone") || "");

    const outcome = await send.submit({
      run: async (signal, submissionId) => {
        const res = await submit({
          signal,
          data: {
            // Every attempt carries the same id, so a retry after a lost reply
            // is recognised as this registration rather than filed as a second
            // person (and emailed a second time).
            client_submission_id: submissionId,
            // The lead is stored as a single name; the waiver keeps the
            // structured parts. Compose here so the DB column is unchanged.
            name: composeFullName(firstName, "", lastName),
            email,
            phone,
            experience: String(fd.get("experience") || ""),
            message: String(fd.get("message") || ""),
            hp: String(fd.get("hp") || ""),
          },
        });
        // Only the server gets to say this worked. Anything else is a bug
        // upstream, and treating it as success would tell someone they are on
        // the list when they are not.
        if (!res?.ok) throw new Error("We couldn't save your details. Please try again.");
        return res;
      },
    });

    if (outcome.ok) setDone({ firstName, lastName, email, phone });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send0();
  }

  // ---- Step 2: lead captured, offer the (prefilled) waiver as the next step ----
  if (done) {
    return (
      <SiteLayout>
        <section className="mx-auto max-w-2xl px-4 py-16 md:py-20">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">Step 2 of 2</p>
          <div className="mt-3 flex items-start gap-3">
            <CheckCircle2 className="mt-1 h-8 w-8 shrink-0 text-primary" />
            <h1 className="text-3xl font-bold md:text-4xl">
              You're on the list! One thing left to be mat-ready.
            </h1>
          </div>

          <div className="mt-8 rounded-2xl border bg-card p-6 md:p-8">
            <div className="flex items-center gap-2 text-primary">
              <FileSignature className="h-5 w-5" />
              <p className="text-sm font-semibold">Sign your waiver now. It's prefilled</p>
            </div>
            <p className="mt-2 text-muted-foreground">
              Two minutes and you're done before you even arrive. We've filled in your details from
              the last step to save you time.
            </p>
            <Button asChild size="lg" className="mt-5 w-full sm:w-auto">
              <Link
                to="/waiver"
                search={{
                  first_name: done.firstName,
                  last_name: done.lastName,
                  email: done.email,
                  phone: done.phone,
                }}
              >
                Sign my waiver
              </Link>
            </Button>
          </div>

          <div className="mt-6 rounded-2xl border bg-muted/30 p-6">
            <p className="text-sm font-medium">Not ready? No problem.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              We'll email you the link and you can sign before you come, or we'll sort it at the
              gym. Either way, just turn up to any beginners class (Mon or Wed). Your first two are
              free.
            </p>
          </div>

          <div className="mt-8">
            <Link
              to="/classes"
              className="text-sm text-muted-foreground underline hover:text-foreground"
            >
              See the class schedule
            </Link>
          </div>
        </section>
      </SiteLayout>
    );
  }

  // ---- Step 1: quick details (low friction, everyone completes this) ----
  return (
    <SiteLayout>
      <section className="mx-auto max-w-2xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Step 1 of 2 · takes 30 seconds
        </p>
        <h1 className="mt-3 text-4xl font-bold">Start your free trial</h1>
        <p className="mt-3 text-muted-foreground">
          Tell us who you are and we'll get you on the mat. Your first two classes are free. No gear
          needed.
        </p>

        <form
          ref={formRef}
          onSubmit={onSubmit}
          className="mt-8 space-y-5 rounded-2xl border bg-card p-6 md:p-8"
        >
          <input type="text" name="hp" tabIndex={-1} autoComplete="off" className="hidden" />
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="first_name">First name</Label>
              <Input id="first_name" name="first_name" required maxLength={60} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="last_name">Last name</Label>
              <Input id="last_name" name="last_name" required maxLength={60} className="mt-1.5" />
            </div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                maxLength={255}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="phone">Phone (optional)</Label>
              <Input id="phone" name="phone" type="tel" maxLength={30} className="mt-1.5" />
              <p className="mt-1.5 text-xs text-muted-foreground">
                By giving us your number you agree we can contact you by SMS or WhatsApp, and add
                you to club WhatsApp groups.
              </p>
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowNote((v) => !v)}
              aria-expanded={showNote}
              aria-controls="note-fields"
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", showNote && "rotate-180")}
              />
              Add a note (optional)
            </button>
            {showNote && (
              <div id="note-fields" className="mt-5 space-y-5">
                <div>
                  <Label htmlFor="experience">Martial arts experience (optional)</Label>
                  <Input
                    id="experience"
                    name="experience"
                    maxLength={500}
                    placeholder="e.g. total beginner, 2 years BJJ..."
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="message">Anything else? (optional)</Label>
                  <Textarea
                    id="message"
                    name="message"
                    maxLength={1000}
                    rows={4}
                    className="mt-1.5"
                  />
                </div>
              </div>
            )}
          </div>

          <Button type="submit" size="lg" disabled={send.busy} className="w-full">
            {send.busy ? "Saving..." : "Continue"}
          </Button>

          <SubmitStatus
            status={send.status}
            attempt={send.attempt}
            attempts={send.attempts}
            error={send.error}
            failureKind={send.failureKind}
            onRetry={() => void send0()}
          />
        </form>
      </section>
    </SiteLayout>
  );
}
