import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitContact } from "@/lib/submissions.functions";
import { VENUE_NAME, VENUE_ADDRESS, GOOGLE_MAPS_URL, APPLE_MAPS_URL } from "@/lib/venue";
import { Phone, MessageCircle, MapPin, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact UTS Jitsu" },
      {
        name: "description",
        content: "Get in touch with UTS Jitsu by phone, WhatsApp, or message.",
      },
      { property: "og:title", content: "Contact UTS Jitsu" },
      { property: "og:description", content: "Phone, WhatsApp, or send us a message." },
      { property: "og:url", content: "https://jitsu.au/contact" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/contact" }],
  }),
  component: Contact,
});

function Contact() {
  const navigate = useNavigate();
  const submit = useServerFn(submitContact);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    try {
      await submit({
        data: {
          name: String(fd.get("name") || ""),
          email: String(fd.get("email") || ""),
          subject: String(fd.get("subject") || ""),
          message: String(fd.get("message") || ""),
          hp: String(fd.get("hp") || ""),
        },
      });
      navigate({ to: "/thank-you", search: { kind: "contact" } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
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
              href="tel:0493631759"
              className="flex items-center gap-3 rounded-xl border bg-card p-5 hover:bg-muted"
            >
              <Phone className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Phone</p>
                <p className="font-medium">0493 631 759</p>
              </div>
            </a>
            <a
              href="https://wa.me/61493631759"
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

          <form onSubmit={onSubmit} className="space-y-5 rounded-2xl border bg-card p-6 md:p-8">
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
            <Button type="submit" size="lg" disabled={loading} className="w-full">
              {loading ? "Sending..." : "Send message"}
            </Button>
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
              </strong>{" "}
              — {VENUE_NAME} is right there, at street level.
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
