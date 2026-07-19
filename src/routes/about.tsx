import { createFileRoute } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteLayout";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About UTS Jitsu — Practical Jiu-Jitsu in Sydney" },
      { name: "description", content: "Meet Sensei Franck and learn about our approach to self-defence, community and fitness at UTS Jitsu." },
      { property: "og:title", content: "About UTS Jitsu" },
      { property: "og:description", content: "Practical Japanese Jiu-Jitsu, inclusive community, and 25+ years of martial arts experience." },
      { property: "og:url", content: "/about" },
    ],
    links: [{ rel: "canonical", href: "/about" }],
  }),
  component: About,
});

const pillars = [
  {
    title: "Our approach to self-defence",
    body: "Our focus is practical self-defence through Japanese Jiu-Jitsu. By simulating encounters under pressure, we make sure students develop the skills to respond effectively and apply techniques when it matters most.",
  },
  {
    title: "An inclusive community",
    body: "Our classes cater to individuals of all levels, whether you're a complete beginner or have previous martial arts experience. We encourage questions and create an environment where everyone progresses at their own pace.",
  },
  {
    title: "Fitness through martial arts",
    body: "Our sessions combine martial arts drills with strength and conditioning, improving your overall fitness, agility and endurance. Expect to be challenged — and to leave sharper than you came in.",
  },
];

function About() {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">About us</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">A modern dojo, rooted in tradition.</h1>
        <p className="mt-5 text-lg text-muted-foreground">
          UTS Jitsu brings Sydney Jitsu's practical Japanese Jiu-Jitsu training to the UTS
          Ultimo campus — an accessible, welcoming space for students, professionals and
          anyone in the CBD looking for a martial art that actually works.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="grid gap-6 md:grid-cols-3">
          {pillars.map((p) => (
            <article key={p.title} className="rounded-xl border bg-card p-6">
              <h2 className="text-lg font-semibold">{p.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{p.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-24">
        <div className="rounded-2xl border bg-card p-8 md:p-12 text-center">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">Coaching team</p>
          <h2 className="mt-2 text-3xl font-bold">Led by Sensei Franck</h2>
          <p className="mt-4 text-muted-foreground">
            25+ years of martial arts experience, backed by a team of assistant instructors
            who help make every class approachable — whatever your starting point.
          </p>
          <div className="mt-6">
            <Link
              to="/instructors"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Meet the instructors
            </Link>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
