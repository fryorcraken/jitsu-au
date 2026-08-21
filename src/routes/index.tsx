import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Shield, Users, Dumbbell, Award, MapPin, Clock, Sparkles } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Testimonials } from "@/components/site/Testimonials";
import { CommonQuestions } from "@/components/site/CommonQuestions";
import { YouTubeEmbed } from "@/components/site/YouTubeEmbed";
import { Button } from "@/components/ui/button";
import { buildClubJsonLd, buildPageMeta } from "@/lib/seo";
import heroAsset from "@/assets/training1.jpg.asset.json";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: buildPageMeta({
      title: "UTS Jitsu | Practical Japanese Jiu-Jitsu in Sydney",
      description:
        "Learn practical self-defence at UTS Ultimo. Beginner-friendly Japanese Jiu-Jitsu classes Mon, Wed & Sat. First two sessions free.",
      path: "/",
    }),
    links: [
      { rel: "canonical", href: "https://jitsu.au/" },
      // Hero image is the page's LCP element but sits well into the body, so the
      // preloader would otherwise only discover it after parsing the head and
      // everything above it in the markup. Preloading it here lets the browser
      // start the fetch immediately, in parallel with the stylesheets.
      { rel: "preload", as: "image", href: heroAsset.url, fetchPriority: "high" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(buildClubJsonLd()),
      },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <SiteLayout>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/10 via-background to-background" />
        <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-12 pb-16 md:grid-cols-2 md:items-center md:pt-20 md:pb-24">
          <div>
            <span className="inline-flex items-start gap-2 rounded-full border bg-background px-3 py-1 text-xs font-medium text-primary">
              <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /> UTS
              students, staff and public members welcome
            </span>
            <h1 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
              Learn practical self-defence at <span className="text-primary">UTS Ultimo</span>.
            </h1>
            <p className="mt-5 max-w-lg text-base text-muted-foreground md:text-lg">
              Build real self-defence skills in a fun and welcoming environment. We train Japanese
              Jiu-Jitsu in Ultimo and welcome the general public and local community, with special
              rates for UTS students. Classes are for beginners and experienced martial artists
              alike.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/register-interest">
                  Start your free trial <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/classes">See class schedule</Link>
              </Button>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Your first two sessions are on us. No gear needed.
            </p>
          </div>
          <div className="relative">
            <div className="absolute -inset-4 -z-10 rounded-3xl bg-primary/10 blur-2xl" />
            <img
              src={heroAsset.url}
              alt="UTS Jitsu students training on the mat"
              width={1600}
              height={1205}
              fetchPriority="high"
              className="aspect-[4/3] w-full rounded-2xl object-cover shadow-xl ring-1 ring-black/5"
            />
          </div>
        </div>
      </section>

      {/* Video */}
      <section className="mx-auto max-w-4xl px-4 pt-4 pb-12">
        <div className="text-center">
          <h2 className="text-2xl font-bold md:text-3xl">See a class in action</h2>
          <p className="mt-2 text-muted-foreground">
            A quick look at what training looks like on the mat.
          </p>
        </div>
        <div className="mt-6">
          <YouTubeEmbed videoId="jm75EhP1zMQ" title="UTS Jitsu class in action" />
        </div>
      </section>

      {/* First-class teaser */}
      <section className="mx-auto max-w-6xl px-4 pt-4">
        <Link
          to="/first-class"
          className="group flex flex-col gap-3 rounded-2xl border bg-secondary p-6 transition-colors hover:bg-muted sm:flex-row sm:items-center sm:justify-between sm:gap-6 md:p-8"
        >
          <div className="flex items-start gap-4">
            <Sparkles className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
            <div>
              <p className="text-lg font-semibold">
                New here? Here's exactly what your first class looks like
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                A step-by-step walkthrough of what to expect, what to bring and how the free trial
                works.
              </p>
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
            Read the guide{" "}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      </section>

      {/* Value props */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid gap-6 md:grid-cols-4">
          {[
            {
              icon: Shield,
              title: "Practical self-defence",
              body: "Techniques trained under pressure so they work when it matters.",
            },
            {
              icon: Users,
              title: "Open to everyone",
              body: "UTS students, staff and the general public train together. All levels welcome, at your own pace.",
            },
            {
              icon: Dumbbell,
              title: "Fitness through art",
              body: "Drills, conditioning and skill for a sharper mind and stronger body.",
            },
            {
              icon: Award,
              title: "Experienced coaches",
              body: "25+ years of martial-arts experience, led by Franck Royer.",
            },
          ].map((c) => (
            <div key={c.title} className="rounded-xl border bg-card p-6">
              <c.icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 text-base font-semibold">{c.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Schedule preview */}
      <section className="border-y bg-muted/30">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-3xl font-bold md:text-4xl">Train with us this week</h2>
              <p className="mt-2 max-w-xl text-muted-foreground">
                Classes run at ActivateFit Gym, inside UTS Building 4 on Harris Street in Ultimo.
                The building is open to the public, so anyone can come to class.
              </p>
            </div>
            <Button asChild variant="outline" className="hidden md:inline-flex">
              <Link to="/classes">Full schedule</Link>
            </Button>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              { day: "Monday", time: "5:30 – 7:00pm" },
              { day: "Wednesday", time: "6:00 – 7:30pm" },
              {
                day: "Saturday",
                time: "10:30am – 12:00pm",
                note: "Colour belts only, from September",
              },
            ].map((s) => (
              <div key={s.day} className="rounded-xl border bg-card p-6">
                <div className="flex items-center gap-2 text-primary">
                  <Clock className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-wider">{s.day}</span>
                </div>
                <p className="mt-2 text-2xl font-bold">{s.time}</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5" /> ActivateFit Gym, Ultimo
                </p>
                {s.note && <p className="mt-3 text-xs text-muted-foreground">{s.note}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <Testimonials />
      </section>

      {/* Common questions — reassurance right before the ask */}
      <section className="mx-auto max-w-3xl px-4 pb-4">
        <CommonQuestions />
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="rounded-3xl bg-primary p-10 text-primary-foreground md:p-16">
          <h2 className="text-3xl font-bold md:text-4xl">Ready to step on the mat?</h2>
          <p className="mt-3 max-w-2xl text-primary-foreground/80">
            Tell us who you are and we'll get you on the mat. Your first two classes are free. No
            gear needed. Takes 30 seconds to start.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-6">
            <Button asChild size="lg" variant="secondary">
              <Link to="/register-interest">Start your free trial</Link>
            </Button>
            <Link
              to="/contact"
              className="text-sm font-medium text-primary-foreground/80 underline underline-offset-4 hover:text-primary-foreground"
            >
              Or contact us with a question
            </Link>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
