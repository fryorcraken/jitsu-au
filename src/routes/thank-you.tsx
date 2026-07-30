import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { z } from "zod";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { buildPageMeta } from "@/lib/seo";

const searchSchema = z.object({
  kind: z.enum(["interest", "waiver", "contact"]).catch("interest"),
});

export const Route = createFileRoute("/thank-you")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      ...buildPageMeta({
        title: "Thank you | UTS Jitsu",
        description: "Thanks for reaching out to UTS Jitsu.",
        path: "/thank-you",
      }),
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/thank-you" }],
  }),
  component: ThankYou,
});

const copy = {
  interest: {
    title: "We got your details!",
    body: "Thanks for registering your interest. We'll be in touch shortly to lock in your first free session.",
  },
  waiver: {
    title: "Waiver received.",
    body: "Thanks. Your signed waiver has been recorded. See you on the mat!",
  },
  contact: { title: "Message sent.", body: "Thanks for reaching out. We'll get back to you soon." },
} as const satisfies Record<z.infer<typeof searchSchema>["kind"], { title: string; body: string }>;

function ThankYou() {
  const { kind } = Route.useSearch();
  const c = copy[kind as keyof typeof copy];
  return (
    <SiteLayout>
      <section className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center">
        <CheckCircle2 className="h-16 w-16 text-primary" />
        <h1 className="mt-6 text-3xl font-bold md:text-4xl">{c.title}</h1>
        <p className="mt-3 text-muted-foreground">{c.body}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link to="/">Back home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/classes">See classes</Link>
          </Button>
        </div>
      </section>
    </SiteLayout>
  );
}
