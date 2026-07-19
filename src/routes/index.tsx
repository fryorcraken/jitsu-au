import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Shield, Users, Dumbbell, Award, MapPin, Clock } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import heroAsset from "@/assets/training1.jpg.asset.json";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "UTS Jitsu — Practical Japanese Jiu-Jitsu in Sydney" },
      {
        name: "description",
        content:
          "Learn practical self-defence at UTS Ultimo. Beginner-friendly Japanese Jiu-Jitsu classes Mon, Wed & Sat. First two sessions free.",
      },
      { property: "og:title", content: "UTS Jitsu — Practical Japanese Jiu-Jitsu in Sydney" },
      { property: "og:description", content: "Beginner-friendly Japanese Jiu-Jitsu at UTS Ultimo. First two sessions free." },
      { property: "og:url", content: "/" },
    ],
    links: [{ rel: "canonical", href: "/" }],
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
            <span className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs font-medium text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Now enrolling for the semester
            </span>
            <h1 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
              Unlock your potential with <span className="text-primary">martial arts</span>.
            </h1>
            <p className="mt-5 max-w-lg text-base text-muted-foreground md:text-lg">
              Build real self-defence skills in a fun and welcoming environment. Japanese
              Jiu-Jitsu at the UTS Ultimo campus — for beginners and experienced martial
              artists alike.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/register-interest">
                  Book a free trial <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/classes">See class schedule</Link>
              </Button>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Your first two sessions are on us — no gear needed.
            </p>
          </div>
          <div className="relative">
            <div className="absolute -inset-4 -z-10 rounded-3xl bg-primary/10 blur-2xl" />
            <img
              src={heroImg}
              alt="Two practitioners training a wrist lock in a modern dojo"
              width={1600}
              height={1000}
              className="aspect-[4/3] w-full rounded-2xl object-cover shadow-xl ring-1 ring-black/5"
            />
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid gap-6 md:grid-cols-4">
          {[
            { icon: Shield, title: "Practical self-defence", body: "Techniques trained under pressure so they work when it matters." },
            { icon: Users, title: "Inclusive community", body: "All levels welcome. We move at your pace, together." },
            { icon: Dumbbell, title: "Fitness through art", body: "Drills, conditioning and skill — sharper mind, stronger body." },
            { icon: Award, title: "Experienced coaches", body: "25+ years of martial-arts experience, led by Sensei Franck." },
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
                Classes run at ActivateFit Gym, on Harris Street in Ultimo.
              </p>
            </div>
            <Button asChild variant="outline" className="hidden md:inline-flex">
              <Link to="/classes">Full schedule</Link>
            </Button>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              { day: "Monday", time: "17:30 — 19:00" },
              { day: "Wednesday", time: "18:00 — 19:30" },
              { day: "Saturday", time: "09:00 — 10:30", note: "From March, invitation only" },
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

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="rounded-3xl bg-primary p-10 text-primary-foreground md:p-16">
          <h2 className="text-3xl font-bold md:text-4xl">Ready to step on the mat?</h2>
          <p className="mt-3 max-w-2xl text-primary-foreground/80">
            Register your interest, sign the club waiver, or drop us a message. Whichever
            way you start, we'll take it from there.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" variant="secondary">
              <Link to="/register-interest">Register interest</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-primary-foreground/30 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground">
              <Link to="/waiver">Sign waiver</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-primary-foreground/30 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground">
              <Link to="/contact">Contact us</Link>
            </Button>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
