import { createFileRoute } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import franckImg from "@/assets/training3.jpg.asset.json";

export const Route = createFileRoute("/instructors")({
  head: () => ({
    meta: [
      { title: "Instructors | UTS Jitsu" },
      { name: "description", content: "Meet the instructors at UTS Jitsu, led by Sensei Franck with 25+ years of martial arts experience." },
      { property: "og:title", content: "Instructors | UTS Jitsu" },
      { property: "og:description", content: "Meet Sensei Franck and the coaching team at UTS Jitsu." },
      { property: "og:url", content: "/instructors" },
    ],
    links: [{ rel: "canonical", href: "/instructors" }],
  }),
  component: Instructors,
});

const franckQualifications = [
  "First degree black belt in Shorinji Kan Jiu-Jitsu as taught by The Jiu-Jitsu Foundation (TJJF UK)",
  "Brazilian Jiu-Jitsu Purple Belt, under Ben Power at Straight Blast Gym Australia",
  "First aid certified, July 2026",
  "Working With Children Check",
  "Insured for martial art instruction and practice",
];

const franckTeaching = [
  {
    period: "January 2026 - Present",
    hours: "3 teaching hours a week",
    org: "UTS Jitsu, Harris St, Australia",
    role: "Reopened as head instructor",
    points: [
      "Weekly classes, 3 hours a week",
      "Running 3 gradings a year",
    ],
  },
  {
    period: "2026 - Present",
    hours: "Seminars 2-3 times a term",
    org: "Philotimo Jiujitsu",
    role: "Seminar instructor",
    points: [
      "Seminars run 2-3 times a term focused on randori, ne waza, and other exercises involving a resisting opponent",
    ],
  },
  {
    period: "2026",
    org: "Sydney Jitsu Syllabus",
    role: "Creation and roll-out",
    points: [
      "Designed and rolled out a new syllabus for Sydney Jitsu, heavily inspired by the previous TJJF UK syllabus",
      "Built around applying techniques against a resisting opponent, so practitioners develop an adaptable game rather than memorising a fixed list of techniques",
      "Prioritises transferable skills and aptitude over rote technique regurgitation",
      "Uses game-based training methods to build self-defence skills in a live, pressure-tested way",
    ],
  },
  {
    period: "2022 - 2026",
    org: "Philotimo Jiujitsu",
    role: "Advisory role",
    points: [
      "Advised on the development of Philotimo Jiujitsu's new syllabus, specifically the nage waza and ne waza content",
      "Ran specific grading exercises during the 2024, 2025 and 2026 yearly gradings",
    ],
  },
  {
    period: "October 2023 - December 2025",
    hours: "40 classes a year, 2 hours each (~80 teaching hours/year)",
    org: "Sydney Jitsu, Canterbury",
    role: "Lead instructor & founder",
    points: [
      "Weekly classes with a mix of beginner and experienced jitsukas",
      "Learning and teaching latest updates of the UK TJJF Syllabus (2023-25)",
      "Regular catch up with other TJJF instructors to discuss new and modified techniques",
      "Adults classes with students from 20 to 50 years of age",
      "Solo handling administration, marketing, recruitment and teaching",
    ],
  },
  {
    period: "July 2025 - October 2025",
    hours: "10 teaching hours",
    org: "Philotimo Freestyle Jujitsu, Hunters Hill",
    role: "Throws and ground work focus classes",
    points: [
      "Run classes focused on ground work and throws at the Philotimo Freestyle JuJitsu dojo",
      "Developed specific exercises to quickly upskill randori, grip fight, balance breaking and pinning",
      "Adapted to the Philotimo syllabus, focusing on improving execution of their game, instead of teaching new techniques",
      "Witnessed great improvement in only 10 weeks, great feedback from both students and instructors",
      "Women only classes, ranging from primary school kids to adults",
    ],
  },
  {
    period: "February 2023 - October 2023",
    hours: "80 teaching hours",
    org: "Philotimo Freestyle Jujitsu, Hunters Hill",
    role: "Mixed sessions, Wednesday classes",
    points: [
      "Ran mixed-gender sessions in a women only dojo",
      "Ran sessions for both beginners and experienced martial artists from another Jiu-Jitsu style",
    ],
  },
  {
    period: "September 2022",
    hours: "10 teaching hours",
    org: "Straight Blast Gym Australia",
    role: "Assistant instructor, BJJ kids sessions",
    points: [
      "Assisted teaching Brazilian Jiu-Jitsu kids sessions",
    ],
  },
  {
    period: "March 2017 - June 2021",
    hours: "Over 600 teaching hours",
    org: "UTS Jitsu, Harris St, Australia",
    role: "Lead instructor & founder",
    points: [
      "Preparation and teaching of weekly sessions",
      "Successfully promoted students during regional and in-house gradings",
      "Ad-hoc organisation of week-end seminars with martial artists of other styles",
      "Guest instructor at \"Girl fight camp\", organised by Sensei Rosemary Smith",
      "Trained 2 students to brown belt, graded by senior UK TJJF instructor, Steve Donaghy (seven dan)",
    ],
  },
  {
    period: "July 2014 - March 2017",
    hours: "Total of 300 teaching hours",
    org: "Sydney Jitsu Club, York St, Australia",
    role: "Lead instructor & founder",
    points: [
      "Preparation and teaching of weekly sessions",
      "Successfully sent 5 students to regional gradings",
      "Ad-hoc organisation of 3 week-end seminars with martial artists of other styles",
    ],
  },
  {
    period: "February 2014 - July 2014",
    hours: "Total of 25 teaching hours",
    org: "Outdoor sessions, Prince Alfred Park, Australia",
    role: "Lead instructor & organiser",
    points: [
      "Teaching lunch time sessions once a week in the park with 4-6 students",
    ],
  },
  {
    period: "July 2013 - January 2014",
    hours: "Total of 110 teaching hours",
    org: "Brunel University Jitsu Club, Uxbridge, UK",
    role: "Lead Instructor",
    points: [
      "Took over the role of lead instructor for the Brunel University Jitsu Club",
      "Taught two, sometimes three times a week",
      "Successfully sent 7 students to the regional grading",
    ],
  },
  {
    period: "April 2013 - June 2013",
    hours: "~Total of 25 teaching hours",
    org: "Imperial College Jitsu Club, London, UK",
    role: "Replacement Instructor",
    points: [
      "Took over Tuesday sessions, 2 hours per week",
      "Collaborated to the successful grading of 4+ students",
    ],
  },
  {
    period: "March 2013 - April 2013",
    org: "Various clubs, Thames Valley, UK",
    role: "Replacement Instructor",
    points: [
      "Covered for instructors at various locations such as Brunel University Jitsu Club, Oxford Town Jitsu Club, Oxford University Jitsu Club & Banbury Town Club",
    ],
  },
];

const franckTraining = [
  {
    period: "08/2020 - Present",
    location: "Sydney, Australia",
    points: [
      "Brazilian Jiu-Jitsu at Straight Blast Gym Australia, under Ben Power, ~450 hours",
      "Kick Boxing at Straight Blast Gym Australia, under Ben Power, ~20 hours",
    ],
  },
  {
    period: "2014 - 2019",
    location: "Sydney, Australia",
    points: [
      "Judo at Newtown Judo Club, ~10 hours",
      "Brazilian Jiu-Jitsu at Gracie Barra St Peters ~50 hours",
      "Judo at Sydney University Judo Club with Sensei Randall, ~10 hours",
      "Koshinryu Jiu-Jitsu at Boxing works with Larry Papadopoulos, Surry hills, ~30 hours",
      "Krav Maga at KMDI, Surry Hills, ~30 hours",
      "Shorinji Kan Jiu-Jitsu with Sensei Jason Hime, private dojo, ~10 hours",
      "Shorinji Kan Jiu-Jitsu at Penrith PCYC Jitsu Club, Penrith, ~50 hours",
      "Shorinji Kan Jiu-Jitsu at Sydney Jitsu Club (external instructors visits), ~20 hours",
      "Kung Fu and Brazilian Jiu-Jitsu at Red Boat Kung Fu, Surry Hills, 10 hours",
    ],
  },
  {
    period: "January 2010 - December 2013",
    location: "London, UK",
    points: [
      "Shorinji Kan Jiu-Jitsu at various clubs of The Jiu-Jitsu Foundation around London, ~900 hours",
      "Attended Nationals and Regionals event of the The Jiu-Jitsu Foundation",
    ],
  },
  {
    period: "September 2008 - September 2009",
    location: "Manchester, UK",
    points: [
      "Shorinji Kan Jiu-Jitsu at Manchester Met and Manchester Uni Jitsu Clubs, ~250 hours",
    ],
  },
  {
    period: "September 1999 - September 2006",
    location: "Bordeaux, France",
    points: [
      "Mushin Ryu Jiu-Jitsu at the Dojo Aquitain, ~1100 hours",
    ],
  },
];

const franckAwards = [
  "09/2025 - Promotion to Brazilian Jiu-Jitsu purple belt by Ben Power (4th degree black belt)",
  "06/2022 - Promotion to Brazilian Jiu-Jitsu blue belt by Ben Power",
  "02/2021 - Weapon Survival Essentials (Charlie) & Weapon Response Framework (Delta) Kinetic Fighting courses under Paul Cale",
  "02/2020 - KEF-1 Kinetic Fighting courses under Paul Cale",
  "10/2019 - KEF-1 & KEF-2 Kinetic Fighting courses under Paul Cale",
  "02/2017 - Promotion to senior primary instructor from Douglas Austing",
  "10/2014 & 10/2015 - Attended the Australian Jiu-Jitsu Association Seminar, Homebush",
  "07/2015 - Promotion to first degree black belt by TJJF, Leeds, UK",
  "05/2015 - Promotion to fighter level 1 by Krav Maga International, Sydney, Australia",
  "03/2013 - Promotion to brown belt, mandated instructor by TJJF, London, UK",
  "11/2012 - Second place at TJJF Atemi Nationals, Dark Blue Belt category, UK",
  "11/2011 - Fourth place at TJJF Atemi Nationals, Purple Belt category, UK",
  "11/2008 - In the finals at TJJF Atemi Nationals, White Belt category, UK",
  "2003 - Promotion to blue belt, 2nd kyu, by The Federation Mushin Ryu Ju-Jutsu, Bordeaux, France",
];

const assistants = [
  {
    name: "James G",
    role: "Assistant instructor",
    bio: "Trained both in the UK and Australia, graded to brown belt 1st Kyu in June 2019.",
  },
  {
    name: "Ivan Ivanov",
    role: "Assistant instructor",
    bio: "Light blue belt, 3rd kyu from TJJF UK.",
  },
];

function HistorySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Collapsible className="border-b py-4 first:pt-0 last:border-b-0">
      <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
        <h3 className="text-lg font-semibold">{title}</h3>
        <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

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

      <section className="mx-auto max-w-5xl px-4 pb-16">
        <div className="overflow-hidden rounded-2xl border bg-card md:grid md:grid-cols-[2fr_3fr]">
          <img
            src={franckImg.url}
            alt="Sensei Franck on the mat"
            className="h-full min-h-[320px] w-full object-cover md:aspect-auto"
          />
          <div className="p-8 md:p-12">
            <p className="text-sm font-semibold uppercase tracking-wider text-primary">Head instructor</p>
            <h2 className="mt-2 text-3xl font-bold">Sensei Franck</h2>
            <p className="mt-4 text-muted-foreground">
              Martial artist for more than 25 years, I am a dedicated teacher and student. I aim to pass on to my students what Japanese Jiu-Jitsu has given me: self-confidence, fitness and self-defence skills. It has been my passion since I started as a teenager, a passion I have conveyed as an instructor for the past 13 years. Over the years, I have trained many martial arts, with a more recent focus on Brazilian Jiu-Jitsu.
            </p>

            <div className="mt-6">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Qualifications
              </h3>
              <ul className="mt-3 space-y-2">
                {franckQualifications.map((c) => (
                  <li key={c} className="flex gap-2 text-sm text-foreground">
                    <span className="text-primary">•</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border bg-card p-6 md:p-8">
          <HistorySection title="Teaching experience">
            <div className="space-y-6">
              {franckTeaching.map((t) => (
                <div key={t.period + t.org}>
                  <p className="font-semibold">{t.period}{t.hours ? ` - ${t.hours}` : ""}</p>
                  <p className="text-sm text-primary">{t.org} - {t.role}</p>
                  <ul className="mt-2 space-y-1">
                    {t.points.map((p, i) => (
                      <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                        <span className="text-primary">•</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </HistorySection>

          <HistorySection title="Training history">
            <div className="space-y-6">
              {franckTraining.map((t) => (
                <div key={t.period + t.location}>
                  <p className="font-semibold">{t.period}</p>
                  <p className="text-sm text-primary">{t.location}</p>
                  <ul className="mt-2 space-y-1">
                    {t.points.map((p, i) => (
                      <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                        <span className="text-primary">•</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </HistorySection>

          <HistorySection title="Awards & special events">
            <ul className="space-y-2">
              {franckAwards.map((a) => (
                <li key={a} className="flex gap-2 text-sm text-muted-foreground">
                  <span className="text-primary">•</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </HistorySection>
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
