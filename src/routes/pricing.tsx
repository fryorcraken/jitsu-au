import { createFileRoute, Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Testimonials } from "@/components/site/Testimonials";
import { Button } from "@/components/ui/button";
import { buildPageMeta } from "@/lib/seo";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: buildPageMeta({
      title: "Pricing | UTS Jitsu",
      description:
        "UTS student and general public fees for Japanese Jiu-Jitsu at UTS Ultimo. Casual, semester, and yearly options.",
      ogDescription: "Casual, semester and yearly options. First two sessions free.",
      path: "/pricing",
    }),
    links: [{ rel: "canonical", href: "https://jitsu.au/pricing" }],
  }),
  component: Pricing,
});

// Hand-written marketing copy, deliberately NOT driven by the membership plan
// catalogue: with more than one dated plan on sale at once (e.g. this
// semester and next, priced differently), a live-catalogue price has no
// single right answer to show a prospective member. Keep this in step with
// the manager-editable prices by hand when they change — see
// docs/memberships.md.
type Tier = {
  title: string;
  price: string;
  period?: string;
  features: string[];
  highlight?: boolean;
};

const student: Tier[] = [
  {
    title: "One semester",
    price: "$245",
    period: "per half-year",
    features: ["Unlimited semester classes", "Grading fee included", "UTS academic calendar dates"],
    highlight: true,
  },
  {
    title: "Casual class",
    price: "$20",
    period: "per session",
    features: ["Any regular class", "Great for trying us out", "No commitment"],
  },
];

const public_: Tier[] = [
  {
    title: "One semester",
    price: "$445",
    period: "per half-year",
    features: ["Unlimited semester classes", "Grading fee included", "UTS academic calendar dates"],
    highlight: true,
  },
  {
    title: "Casual class",
    price: "$30",
    period: "per session",
    features: ["Any regular class", "Flexible, no commitment"],
  },
];

const extras = [
  {
    title: "First two sessions",
    price: "Free",
    note: "Any time during the semester. No gear needed",
  },
  {
    title: "Sydney Jitsu yearly membership",
    price: "$60",
    note: "Insurance & club affiliation",
  },
  { title: "Uniform (Gi + belt)", price: "$90", note: "Jacket, pants and belt" },
];

function TierCard({ tier }: { tier: Tier }) {
  return (
    <div
      className={`rounded-2xl border p-6 ${tier.highlight ? "bg-primary text-primary-foreground shadow-lg" : "bg-card"}`}
    >
      <h3 className="text-lg font-semibold">{tier.title}</h3>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-4xl font-bold tracking-tight">{tier.price}</span>
        {tier.period && (
          <span
            className={
              tier.highlight
                ? "text-primary-foreground/70 text-sm"
                : "text-muted-foreground text-sm"
            }
          >
            {tier.period}
          </span>
        )}
      </div>
      <ul className="mt-5 space-y-2 text-sm">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check
              className={`mt-0.5 h-4 w-4 shrink-0 ${tier.highlight ? "text-primary-foreground" : "text-primary"}`}
            />
            <span
              className={tier.highlight ? "text-primary-foreground/90" : "text-muted-foreground"}
            >
              {f}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pricing() {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Pricing</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">Simple, honest fees.</h1>
        <p className="mt-5 text-lg text-muted-foreground">
          Your first two sessions are free, any time during the semester. When you're ready to join,
          pick the option that suits how you want to train.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4">
        <h2 className="text-2xl font-bold">For UTS students</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {student.map((t) => (
            <TierCard key={t.title} tier={t} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-2xl font-bold">For the general public</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {public_.map((t) => (
            <TierCard key={t.title} tier={t} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16">
        <h2 className="text-2xl font-bold">Also good to know</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {extras.map((e) => (
            <div key={e.title} className="rounded-xl border bg-card p-6">
              <h3 className="text-base font-semibold">{e.title}</h3>
              <p className="mt-2 text-2xl font-bold text-primary">{e.price}</p>
              <p className="mt-1 text-sm text-muted-foreground">{e.note}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          Saturday sessions are best-effort and included in semester price, but not guaranteed. No
          classes during the UTS summer break.
        </p>
        <div className="mt-6">
          <Button asChild variant="outline">
            <Link to="/membership">Join or manage your membership</Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16">
        <Testimonials heading="Trusted by students like you" />
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="rounded-2xl bg-secondary p-8 text-center md:p-12">
          <h2 className="text-2xl font-bold">Come try a class first.</h2>
          <p className="mt-2 text-muted-foreground">Two free sessions, no commitment.</p>
          <div className="mt-6 flex justify-center">
            <Button asChild size="lg">
              <Link to="/register-interest">Start your free trial</Link>
            </Button>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
