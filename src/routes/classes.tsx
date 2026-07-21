import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Clock, MapPin, Phone } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/classes")({
  head: () => ({
    meta: [
      { title: "Classes & Schedule | UTS Jitsu" },
      {
        name: "description",
        content:
          "Weekly Japanese Jiu-Jitsu classes at ActivateFit Gym, Ultimo. Monday, Wednesday and Saturday.",
      },
      { property: "og:title", content: "Classes & Schedule | UTS Jitsu" },
      {
        property: "og:description",
        content: "Monday, Wednesday and Saturday classes at ActivateFit Gym, Ultimo.",
      },
      { property: "og:url", content: "https://jitsu.au/classes" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/classes" }],
  }),
  component: Classes,
});

const schedule = [
  { day: "Monday", time: "17:30 – 19:00", note: "All levels welcome" },
  { day: "Wednesday", time: "18:00 – 19:30", note: "All levels welcome" },
  { day: "Saturday", time: "09:00 – 10:30", note: "Colour belts only" },
];

function Classes() {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Classes</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">Train with us in Ultimo.</h1>
        <p className="mt-5 text-lg text-muted-foreground">
          Sessions run at ActivateFit Gym on Harris Street, a modern, well-equipped facility on the
          main UTS campus, easy to reach from the CBD.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4">
        <div className="grid gap-4 md:grid-cols-3">
          {schedule.map((s) => (
            <div key={s.day} className="rounded-xl border bg-card p-6">
              <div className="flex items-center gap-2 text-primary">
                <Clock className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-wider">{s.day}</span>
              </div>
              <p className="mt-2 text-2xl font-bold">{s.time}</p>
              <p className="mt-3 text-sm text-muted-foreground">{s.note}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="rounded-2xl border bg-card p-8 md:flex md:items-center md:justify-between md:p-10">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-primary">New here?</p>
            <h2 className="mt-2 text-2xl font-bold">Your first class, step by step</h2>
            <p className="mt-2 max-w-xl text-muted-foreground">
              What to expect, what to bring and exactly what happens on the mat — plus how the free,
              no-commitment trial works.
            </p>
          </div>
          <div className="mt-6 md:mt-0">
            <Button asChild>
              <Link to="/first-class">
                See what your first class looks like <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="rounded-2xl bg-secondary p-8 md:flex md:items-center md:justify-between md:p-12">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-primary">
              <MapPin className="h-4 w-4" /> Location
            </p>
            <h2 className="mt-2 text-2xl font-bold">ActivateFit Gym, Harris Street, Ultimo NSW</h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Phone className="h-4 w-4" />{" "}
              <a href="tel:0493631759" className="hover:text-foreground">
                0493 631 759
              </a>
            </p>
          </div>
          <div className="mt-6 flex flex-wrap gap-3 md:mt-0">
            <Button asChild>
              <Link to="/register-interest">Start your free trial</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/pricing">View pricing</Link>
            </Button>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
