import { createFileRoute, Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Testimonials } from "@/components/site/Testimonials";
import { Button } from "@/components/ui/button";
import { formatCents, sellableSemesters } from "@/lib/validation";
import { formatDateOnly } from "@/lib/dates";
import { listMembershipPlans, listSemesters } from "@/lib/membership.functions";
import { buildPageMeta } from "@/lib/seo";

type PlanSummary = Awaited<ReturnType<typeof listMembershipPlans>>[number];
type SemesterSummary = Awaited<ReturnType<typeof listSemesters>>[number];

export const Route = createFileRoute("/pricing")({
  // Prices come from the manager-editable plan catalog (single source of truth).
  // Fall back to an empty list on any error so the page still renders with the
  // static copy. The explicit return type keeps both branches on one shape.
  loader: async (): Promise<{ plans: PlanSummary[]; semesters: SemesterSummary[] }> => {
    try {
      const [plans, semesters] = await Promise.all([listMembershipPlans(), listSemesters()]);
      return { plans, semesters };
    } catch {
      return { plans: [], semesters: [] };
    }
  },
  head: () => ({
    meta: buildPageMeta({
      title: "Pricing | UTS Jitsu",
      description:
        "UTS student and general public fees for Japanese Jiu-Jitsu at UTS Ultimo. Casual, semester, and yearly options.",
      ogDescription: "Casual, semester and yearly options. First two sessions are always free.",
      path: "/pricing",
    }),
    links: [{ rel: "canonical", href: "https://jitsu.au/pricing" }],
  }),
  component: Pricing,
});

type Rate = "student" | "public";
type Tier = {
  title: string;
  price: string;
  period?: string;
  features: string[];
  highlight?: boolean;
  // When set, the displayed price is taken from the plan catalog (falling back
  // to the static `price` above if the plan is unavailable).
  planCode?: string;
  rate?: Rate;
};

const student: Tier[] = [
  {
    title: "One semester",
    price: "$245",
    period: "per half-year",
    features: ["Unlimited semester classes", "Grading fee included", "UTS academic calendar dates"],
    highlight: true,
    planCode: "semester",
    rate: "student",
  },
  {
    title: "Casual class",
    price: "$20",
    period: "per session",
    features: ["Any regular class", "Great for trying us out", "No commitment"],
    planCode: "casual_session",
    rate: "student",
  },
];

const public_: Tier[] = [
  {
    title: "One semester",
    price: "$445",
    period: "per half-year",
    features: ["Unlimited semester classes", "Grading fee included", "UTS academic calendar dates"],
    highlight: true,
    planCode: "semester",
    rate: "public",
  },
  {
    title: "Casual class",
    price: "$30",
    period: "per session",
    features: ["Any regular class", "Flexible, no commitment"],
    planCode: "casual_session",
    rate: "public",
  },
];

const extras = [
  {
    title: "First two sessions",
    price: "Free",
    note: "All year long. No gear needed",
    planCode: "trial_2_session",
  },
  {
    title: "Sydney Jitsu yearly membership",
    price: "$60",
    note: "Insurance & club affiliation",
    planCode: "insurance_yearly",
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
  // `useLoaderData` widens to `any` for this route, so pin the shape explicitly.
  const { plans, semesters }: { plans: PlanSummary[]; semesters: SemesterSummary[] } =
    Route.useLoaderData();
  const byCode = new Map(plans.map((p) => [p.code, p]));

  // Prefer the live catalog price; fall back to the static copy on the tier.
  const priceFor = (tier: Tier): string => {
    if (!tier.planCode) return tier.price;
    const plan = byCode.get(tier.planCode);
    if (!plan) return tier.price;
    const cents =
      tier.rate === "student" && plan.student_price_cents != null
        ? plan.student_price_cents
        : plan.public_price_cents;
    return formatCents(cents);
  };
  const extraPrice = (e: (typeof extras)[number]): string => {
    if (!e.planCode) return e.price;
    const plan = byCode.get(e.planCode);
    if (!plan) return e.price;
    return formatCents(plan.public_price_cents);
  };

  // The semester tier's third bullet names the actual dates on sale right now
  // (the one running today, or the next to open) instead of a vague promise,
  // while keeping the "UTS calendar" framing that motivated showing dates at
  // all. Falls back to the static copy when no semester is configured yet.
  const currentOrNextSemester = sellableSemesters(semesters, new Date().toISOString())[0] ?? null;
  const semesterDatesLabel = currentOrNextSemester
    ? `UTS calendar dates: ${formatDateOnly(currentOrNextSemester.starts_on)} to ${formatDateOnly(currentOrNextSemester.ends_on)}`
    : null;
  const featuresFor = (tier: Tier): string[] =>
    tier.planCode === "semester" && semesterDatesLabel
      ? [tier.features[0], tier.features[1], semesterDatesLabel]
      : tier.features;

  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Pricing</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">Simple, honest fees.</h1>
        <p className="mt-5 text-lg text-muted-foreground">
          Your first two sessions are free, every day of the year. When you're ready to join, pick
          the option that suits how you want to train.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4">
        <h2 className="text-2xl font-bold">For UTS students</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {student.map((t) => (
            <TierCard key={t.title} tier={{ ...t, price: priceFor(t), features: featuresFor(t) }} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-2xl font-bold">For the general public</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {public_.map((t) => (
            <TierCard key={t.title} tier={{ ...t, price: priceFor(t), features: featuresFor(t) }} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16">
        <h2 className="text-2xl font-bold">Also good to know</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {extras.map((e) => (
            <div key={e.title} className="rounded-xl border bg-card p-6">
              <h3 className="text-base font-semibold">{e.title}</h3>
              <p className="mt-2 text-2xl font-bold text-primary">{extraPrice(e)}</p>
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
