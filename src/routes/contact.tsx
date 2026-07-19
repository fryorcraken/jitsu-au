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
import { Phone, MessageCircle } from "lucide-react";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact UTS Jitsu" },
      { name: "description", content: "Get in touch with UTS Jitsu — phone, WhatsApp, or send us a message." },
      { property: "og:title", content: "Contact UTS Jitsu" },
      { property: "og:description", content: "Phone, WhatsApp, or send us a message." },
      { property: "og:url", content: "/contact" },
    ],
    links: [{ rel: "canonical", href: "/contact" }],
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
          Questions about classes, trials or membership? Reach out — we'll get back to you.
        </p>

        <div className="mt-10 grid gap-8 md:grid-cols-[1fr_1.2fr]">
          <div className="space-y-4">
            <a href="tel:0493631759" className="flex items-center gap-3 rounded-xl border bg-card p-5 hover:bg-muted">
              <Phone className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Phone</p>
                <p className="font-medium">0493 631 759</p>
              </div>
            </a>
            <a href="https://wa.me/610493631759" className="flex items-center gap-3 rounded-xl border bg-card p-5 hover:bg-muted">
              <MessageCircle className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">WhatsApp</p>
                <p className="font-medium">Message us</p>
              </div>
            </a>
            <div className="rounded-xl border bg-card p-5">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Location</p>
              <p className="mt-1 font-medium">ActivateFit Gym</p>
              <p className="text-sm text-muted-foreground">Harris Street, Ultimo NSW</p>
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
                <Input id="email" name="email" type="email" required maxLength={255} className="mt-1.5" />
              </div>
            </div>
            <div>
              <Label htmlFor="subject">Subject (optional)</Label>
              <Input id="subject" name="subject" maxLength={150} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="message">Message</Label>
              <Textarea id="message" name="message" required maxLength={2000} rows={6} className="mt-1.5" />
            </div>
            <Button type="submit" size="lg" disabled={loading} className="w-full">
              {loading ? "Sending..." : "Send message"}
            </Button>
          </form>
        </div>
      </section>
    </SiteLayout>
  );
}
