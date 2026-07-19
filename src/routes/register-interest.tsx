import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { submitInterest } from "@/lib/submissions.functions";

export const Route = createFileRoute("/register-interest")({
  head: () => ({
    meta: [
      { title: "Register your interest — UTS Jitsu" },
      { name: "description", content: "Book a free trial class at UTS Jitsu. We'll be in touch to confirm your first session." },
      { property: "og:title", content: "Register your interest — UTS Jitsu" },
      { property: "og:description", content: "Book a free trial class at UTS Jitsu." },
      { property: "og:url", content: "/register-interest" },
    ],
    links: [{ rel: "canonical", href: "/register-interest" }],
  }),
  component: RegisterInterest,
});

function RegisterInterest() {
  const navigate = useNavigate();
  const submit = useServerFn(submitInterest);
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
          phone: String(fd.get("phone") || ""),
          uts_student: fd.get("uts_student") === "on",
          experience: String(fd.get("experience") || ""),
          message: String(fd.get("message") || ""),
          hp: String(fd.get("hp") || ""),
        },
      });
      navigate({ to: "/thank-you", search: { kind: "interest" } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-2xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Register interest</p>
        <h1 className="mt-3 text-4xl font-bold">Book your free trial.</h1>
        <p className="mt-3 text-muted-foreground">
          Leave your details and we'll be in touch to lock in your first session. Your
          first two classes are on us.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-5 rounded-2xl border bg-card p-6 md:p-8">
          <input type="text" name="hp" tabIndex={-1} autoComplete="off" className="hidden" />
          <div>
            <Label htmlFor="name">Full name</Label>
            <Input id="name" name="name" required maxLength={100} className="mt-1.5" />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required maxLength={255} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="phone">Phone (optional)</Label>
              <Input id="phone" name="phone" type="tel" maxLength={30} className="mt-1.5" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="uts_student" name="uts_student" />
            <Label htmlFor="uts_student" className="font-normal">I'm a UTS student</Label>
          </div>
          <div>
            <Label htmlFor="experience">Martial arts experience (optional)</Label>
            <Input id="experience" name="experience" maxLength={500} placeholder="e.g. total beginner, 2 years BJJ..." className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="message">Anything else? (optional)</Label>
            <Textarea id="message" name="message" maxLength={1000} rows={4} className="mt-1.5" />
          </div>
          <Button type="submit" size="lg" disabled={loading} className="w-full">
            {loading ? "Sending..." : "Send my details"}
          </Button>
        </form>
      </section>
    </SiteLayout>
  );
}
