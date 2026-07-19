import { createFileRoute } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteLayout";

export const Route = createFileRoute("/instructors")({
  head: () => ({
    meta: [
      { title: "Instructors — UTS Jitsu" },
      { name: "description", content: "Meet the instructors at UTS Jitsu — led by Sensei Franck with 25+ years of martial arts experience." },
      { property: "og:title", content: "Instructors — UTS Jitsu" },
      { property: "og:description", content: "Meet Sensei Franck and the coaching team at UTS Jitsu." },
      { property: "og:url", content: "/instructors" },
    ],
    links: [{ rel: "canonical", href: "/instructors" }],
  }),
  component: Instructors,
});

const franckCredentials = [
  "Black belt — Shorinji Kan Jiu-Jitsu",
  "Purple belt — Brazilian Jiu-Jitsu",
  "Level 1 Grey belt — KEF-IC (Krav Maga)",
  "25+ years training across Judo, kickboxing and Krav Maga",
];

const assistants = [
  {
    name: "Coach TBA",
    role: "Assistant instructor",
    bio: "Long-time student of Sensei Franck, focused on fundamentals, breakfalls and beginner onboarding.",
  },
  {
    name: "Coach TBA",
    role: "Assistant instructor",
    bio: "Supports sparring rounds and conditioning drills, with a background in grappling and striking arts.",
  },
];

function Instructors() {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Instructors</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">The people on the mat with you.</h1>
        <p className="mt-5 text-lg text-muted-foreground">
          Our coaching team blends decades of martial arts experience with a modern,
          student-first approach. Every class is led or supervised by a qualified instructor.
        </p>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-16">
        <div className="rounded-2xl border bg-card p-8 md:p-12">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">Head instructor</p>
          <h2 className="mt-2 text-3xl font-bold">Sensei Franck</h2>
          <p className="mt-4 text-muted-foreground">
            Sensei Franck has been training in martial arts for over 25 years, with a core
            focus on Japanese Jiu-Jitsu. His journey spans Judo, kickboxing, Brazilian
            Jiu-Jitsu and Krav Maga — a breadth of experience that shapes how he teaches
            practical, pressure-tested self-defence.
          </p>
          <p className="mt-3 text-muted-foreground">
            He founded UTS Jitsu to bring the same standard of coaching he developed at
            Sydney Jitsu to the UTS Ultimo campus. His emphasis on critical thinking and
            student autonomy means every technique is taught with the "why" behind it, so
            students can adapt under pressure rather than memorising fixed responses.
          </p>
          <p className="mt-3 text-muted-foreground">
            Off the mat, Franck is a strong believer in inclusive training environments —
            classes are structured so beginners and advanced students can progress side by
            side without anyone being left behind.
          </p>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Credentials
            </h3>
            <ul className="mt-3 space-y-2">
              {franckCredentials.map((c) => (
                <li key={c} className="flex gap-2 text-sm text-foreground">
                  <span className="text-primary">•</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24">
        <h2 className="text-2xl font-bold">Assistant instructors</h2>
        <p className="mt-2 text-muted-foreground">
          Supporting Sensei Franck on the mat during classes and open sessions.
        </p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {assistants.map((a) => (
            <article key={a.name} className="rounded-xl border bg-card p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">{a.role}</p>
              <h3 className="mt-1 text-xl font-semibold">{a.name}</h3>
              <p className="mt-3 text-sm text-muted-foreground">{a.bio}</p>
            </article>
          ))}
        </div>
      </section>
    </SiteLayout>
  );
}
