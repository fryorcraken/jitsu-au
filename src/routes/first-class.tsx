import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  ClipboardCheck,
  Clock,
  Droplets,
  Shirt,
  MapPin,
  Users,
  HeartPulse,
  Phone,
  MessageCircle,
  Mail,
} from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { buildPageMeta } from "@/lib/seo";
import { VENUE_PHONE_DISPLAY, VENUE_PHONE_TEL, WHATSAPP_URL } from "@/lib/venue";

export const Route = createFileRoute("/first-class")({
  head: () => ({
    meta: buildPageMeta({
      title: "Your First Class | UTS Jitsu",
      description:
        "Nervous about your first Jiu-Jitsu class? Here's exactly what happens, what to bring and how the free trial works at UTS Jitsu in Ultimo.",
      ogDescription:
        "A step-by-step walkthrough of your first Japanese Jiu-Jitsu session in Ultimo: what to expect, what to bring and how the free trial works.",
      path: "/first-class",
    }),
    links: [{ rel: "canonical", href: "https://jitsu.au/first-class" }],
  }),
  component: FirstClass,
});

const beforeSteps = [
  {
    icon: ClipboardCheck,
    title: "Sign your waiver",
    body: "Do it online ahead of time, or we'll sort it at the gym. Whatever's easier.",
  },
  {
    icon: Clock,
    title: "Show up 5 minutes early",
    body: "A few minutes' head start means you're relaxed and ready when we begin.",
  },
  {
    icon: Droplets,
    title: "Bring a water bottle",
    body: "You'll work up a sweat, so keep some water on hand.",
  },
  {
    icon: Shirt,
    title: "Wear comfy clothes",
    body: "Long sleeves and pants recommended. We train barefoot, but bring sliders or thongs for off the mat.",
  },
];

const matSteps = [
  {
    icon: Users,
    title: "Warm up together",
    body: "We warm up all together and run through some drills to get moving.",
  },
  {
    icon: HeartPulse,
    title: "Break-falls and rolls",
    body: "An instructor works with you on break-falling and rolls so you can move safely.",
  },
  {
    icon: Users,
    title: "Learn with a partner",
    body: "You pair up with partners to learn techniques, adapted to your level.",
  },
  {
    icon: ClipboardCheck,
    title: "Test it with games",
    body: "We play some games to pressure-test the techniques in a fun way.",
  },
  {
    icon: HeartPulse,
    title: "Cool down and stretch",
    body: "We finish with a cool down and stretches.",
  },
];

function FirstClass() {
  return (
    <SiteLayout>
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Your first class
        </p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">
          Here's exactly what your first class looks like.
        </h1>
        <p className="mt-5 text-lg text-muted-foreground">
          Walking into a martial-arts gym for the first time can feel intimidating. It shouldn't be.
          Here's a step-by-step run-through of a session, so you know exactly what to expect before
          you arrive. No surprises, no pressure.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/register-interest">
              Start your free trial <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/waiver">Sign your waiver</Link>
          </Button>
        </div>
      </section>

      {/* Before your first class */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold md:text-3xl">Before your first class</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {beforeSteps.map((s, i) => (
            <div key={s.title} className="flex gap-4 rounded-xl border bg-card p-6">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                {i + 1}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <s.icon className="h-4 w-4 text-primary" />
                  <h3 className="text-base font-semibold">{s.title}</h3>
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* When you arrive */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-2xl border bg-secondary p-8 md:p-10">
          <p className="flex items-center gap-2 text-sm font-semibold text-primary">
            <MapPin className="h-4 w-4" /> When you arrive
          </p>
          <h2 className="mt-2 text-2xl font-bold md:text-3xl">
            Just say you're here for the jitsu trial.
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            At the <strong className="text-foreground">ActivateFit reception</strong>, tell them
            you're <strong className="text-foreground">here for the jitsu trial</strong>. They'll
            ask you to <strong className="text-foreground">sign the paper sign-in sheet</strong>.
            That's all you need to get in for the session.
          </p>
        </div>
      </section>

      {/* What happens on the mat */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold md:text-3xl">What happens on the mat</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Every session follows the same friendly rhythm. Nothing is sprung on you, and everything
          is adapted to your level.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {matSteps.map((s, i) => (
            <div key={s.title} className="rounded-xl border bg-card p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  {i + 5}
                </div>
                <s.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* No payment, no commitment */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-2xl bg-primary p-8 text-primary-foreground md:p-12">
          <h2 className="text-2xl font-bold md:text-3xl">No payment, no commitment</h2>
          <ul className="mt-6 grid gap-4 text-primary-foreground/90 md:grid-cols-2">
            <li className="flex gap-3">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-foreground" />
              <span>
                The trial is <strong className="text-primary-foreground">completely free</strong>.
                No payment, no card or payment details, no commitment required.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-foreground" />
              <span>
                Use your{" "}
                <strong className="text-primary-foreground">2 free sessions at any point</strong>{" "}
                during the semester. They don't have to be back-to-back.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-foreground" />
              <span>
                Keep an eye out for the{" "}
                <strong className="text-primary-foreground">offers we usually run</strong> at the
                start of each semester.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-foreground" />
              <span>
                For your trial you just{" "}
                <strong className="text-primary-foreground">
                  sign the paper sheet at reception
                </strong>{" "}
                each time. Once you decide to join, the ActivateFit reception enters you into the
                system, so you won't need to sign in on every visit.
              </span>
            </li>
          </ul>
          <div className="mt-8">
            <Button asChild size="lg" variant="secondary">
              <Link to="/register-interest">Start your free trial</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Ask us */}
      <section className="mx-auto max-w-6xl px-4 py-8 pb-24">
        <div className="rounded-2xl border bg-card p-8 md:flex md:items-center md:justify-between md:p-10">
          <div>
            <h2 className="text-2xl font-bold">Got a question before you come?</h2>
            <p className="mt-2 text-muted-foreground">
              Ask us by email, WhatsApp or phone. We're happy to help.
            </p>
          </div>
          <div className="mt-6 flex flex-wrap gap-3 md:mt-0">
            <Button asChild variant="outline">
              <a href="mailto:sensei@utsjitsu.com.au">
                <Mail className="mr-1.5 h-4 w-4" /> Email us
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={WHATSAPP_URL}>
                <MessageCircle className="mr-1.5 h-4 w-4" /> WhatsApp
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={VENUE_PHONE_TEL}>
                <Phone className="mr-1.5 h-4 w-4" /> {VENUE_PHONE_DISPLAY}
              </a>
            </Button>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
