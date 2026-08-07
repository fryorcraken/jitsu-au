import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { SiteLayout } from "@/components/site/SiteLayout";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { submitContact } from "@/lib/submissions.functions";
import {
  VENUE_NAME,
  VENUE_ADDRESS,
  GOOGLE_MAPS_URL,
  APPLE_MAPS_URL,
  VENUE_PHONE_DISPLAY,
  VENUE_PHONE_TEL,
  WHATSAPP_URL,
} from "@/lib/venue";
import { Phone, MessageCircle, MapPin, ExternalLink } from "lucide-react";
import { buildPageMeta } from "@/lib/seo";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: buildPageMeta({
      title: "Contact UTS Jitsu",
      description: "Get in touch with UTS Jitsu by phone, WhatsApp, or message.",
      ogDescription: "Phone, WhatsApp, or send us a message.",
      path: "/contact",
    }),
    links: [{ rel: "canonical", href: "https://jitsu.au/contact" }],
  }),
  component: Contact,
});

function Contact() {
  const navigate = useNavigate();
  const submit = useServerFn(submitContact);
  const formRef = useRef<HTMLFormElement | null>(null);
  const send = useResilientSubmit<{ ok: true; duplicate: boolean }>(INTAKE_SUBMIT);

  // Reads the live form each time it is called, so "Try again" needs no state of
  // its own and a failure leaves the message exactly as it was typed. (Automatic
  // retries inside one call reuse this snapshot, which is what we want: they are
  // resending the same submission, not a newly edited one.)
  async function send0() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);

    const outcome = await send.submit({
      run: async (signal, submissionId) => {
        const res = await submit({
          signal,
          data: {
            // Same id on every attempt: a retry after a lost reply is this
            // message, not a second copy of it in the club's inbox.
            client_submission_id: submissionId,
            name: String(fd.get("name") || ""),
            email: String(fd.get("email") || ""),
            subject: String(fd.get("subject") || ""),
            message: String(fd.get("message") || ""),
            hp: String(fd.get("hp") || ""),
          },
        });
        if (!res?.ok) throw new Error("We couldn't send your message. Please try again.");
        return res;
      },
    });

    if (outcome.ok) navigate({ to: "/thank-you", search: { kind: "contact" } });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send0();
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-5xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Contact</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">Get in touch.</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Questions about classes, trials or membership? Reach out and we'll get back to you.
        </p>

        <div className="mt-10 grid gap-8 md:grid-cols-[1fr_1.2fr]">
          <div className="space-y-4">
            <a
              href={VENUE_PHONE_TEL}
              className="flex items-center gap-3 rounded-xl border bg-card p-5 hover:bg-muted"
            >
              <Phone className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Phone</p>
                <p className="font-medium">{VENUE_PHONE_DISPLAY}</p>
              </div>
            </a>
            <a
              href={WHATSAPP_URL}
              className="flex items-center gap-3 rounded-xl border bg-card p-5 hover:bg-muted"
            >
              <MessageCircle className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">WhatsApp</p>
                <p className="font-medium">Message us</p>
              </div>
            </a>
            <div className="rounded-xl border bg-card p-5">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Location</p>
              <p className="mt-1 font-medium">{VENUE_NAME}</p>
              <p className="text-sm text-muted-foreground">{VENUE_ADDRESS}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <a href={GOOGLE_MAPS_URL} target="_blank" rel="noopener noreferrer">
                    <MapPin className="h-4 w-4" /> Google Maps
                    <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={APPLE_MAPS_URL} target="_blank" rel="noopener noreferrer">
                    <MapPin className="h-4 w-4" /> Apple Maps
                    <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                  </a>
                </Button>
              </div>
            </div>
          </div>

          <form
            ref={formRef}
            onSubmit={onSubmit}
            className="space-y-5 rounded-2xl border bg-card p-6 md:p-8"
          >
            <input type="text" name="hp" tabIndex={-1} autoComplete="off" className="hidden" />
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required maxLength={100} className="mt-1.5" />
              </div>
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
            </div>
            <div>
              <Label htmlFor="subject">Subject (optional)</Label>
              <Input id="subject" name="subject" maxLength={150} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="message">Message</Label>
              <Textarea
                id="message"
                name="message"
                required
                maxLength={2000}
                rows={6}
                className="mt-1.5"
              />
            </div>
            <Button type="submit" size="lg" disabled={send.busy} className="w-full">
              {send.busy ? "Sending..." : "Send message"}
            </Button>

            <SubmitStatus
              status={send.status}
              attempt={send.attempt}
              attempts={send.attempts}
              error={send.error}
              failureKind={send.failureKind}
              onRetry={() => void send0()}
              fallback={
                <p className="text-sm text-muted-foreground">
                  You can also call or WhatsApp us on the numbers above.
                </p>
              }
            />
          </form>
        </div>

        <div className="mt-8 rounded-2xl border bg-secondary p-6 md:p-8">
          <p className="flex items-center gap-2 text-sm font-semibold text-primary">
            <MapPin className="h-4 w-4" /> Getting there
          </p>
          <h2 className="mt-2 text-2xl font-bold">Finding {VENUE_NAME}</h2>
          <ul className="mt-4 max-w-2xl space-y-2 text-muted-foreground">
            <li>
              Enter via{" "}
              <strong className="text-foreground">
                Building 4, at the corner of Harris St and Thomas St
              </strong>
              . {VENUE_NAME} is right there, at street level.
            </li>
            <li>
              Coming from the UTS campus? Head down the{" "}
              <strong className="text-foreground">internal set of stairs</strong>.
            </li>
          </ul>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <a href={GOOGLE_MAPS_URL} target="_blank" rel="noopener noreferrer">
                <MapPin className="h-4 w-4" /> Open in Google Maps
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={APPLE_MAPS_URL} target="_blank" rel="noopener noreferrer">
                <MapPin className="h-4 w-4" /> Open in Apple Maps
              </a>
            </Button>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
