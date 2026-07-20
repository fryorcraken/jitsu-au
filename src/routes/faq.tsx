import { createFileRoute } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export const Route = createFileRoute("/faq")({
  head: () => ({
    meta: [
      { title: "FAQ | UTS Jitsu" },
      { name: "description", content: "Answers to common questions about starting Japanese Jiu-Jitsu at UTS Jitsu." },
      { property: "og:title", content: "FAQ | UTS Jitsu" },
      { property: "og:description", content: "Trial classes, gear, experience needed, and more." },
      { property: "og:url", content: "/faq" },
    ],
    links: [{ rel: "canonical", href: "/faq" }],
    scripts: [{
      type: "application/ld+json",
      children: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faq.map((q) => ({
          "@type": "Question",
          name: q.q,
          acceptedAnswer: { "@type": "Answer", text: q.a },
        })),
      }),
    }],
  }),
  component: Faq,
});

const faq = [
  {
    q: "Is there a trial offer?",
    a: "Absolutely. Your first two sessions are on us. It's a great opportunity to experience our training firsthand and see if it's the right fit.",
  },
  {
    q: "What equipment do I need?",
    a: "For your trial session, no equipment is needed. Once you decide to join, you'll need a mouth guard and a Gi uniform. We can help you source both.",
  },
  {
    q: "What should I wear to my first class?",
    a: "Wear whatever you're comfortable in. We recommend pants and a long-sleeve t-shirt. Bring a water bottle too.",
  },
  {
    q: "Do I need prior martial arts experience?",
    a: "Not at all. Our training is structured for every skill level, from complete beginner to experienced practitioner. We support your progress at your own pace.",
  },
  {
    q: "How is Japanese Jiu-Jitsu different from other martial arts?",
    a: "Japanese Jiu-Jitsu is comprehensive. It includes striking, throws, joint locks and ground work, with a focus on self-defence techniques applicable to real-life situations.",
  },
  {
    q: "What's the difference between Japanese and Brazilian Jiu-Jitsu?",
    a: "They share roots but have different focuses. Japanese Jiu-Jitsu covers a wide range: strikes, throws, joint locks and ground work. Our focus is on practical self-defence. Brazilian Jiu-Jitsu concentrates on ground fighting and submissions.",
  },
];

function Faq() {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-3xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">FAQ</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">Frequently asked questions</h1>
        <p className="mt-4 text-muted-foreground">
          Can't find what you're looking for? <a className="text-primary underline underline-offset-4" href="/contact">Contact us</a>.
        </p>
        <Accordion type="single" collapsible className="mt-8">
          {faq.map((item, i) => (
            <AccordionItem value={`item-${i}`} key={item.q}>
              <AccordionTrigger className="text-left text-base font-semibold">{item.q}</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">{item.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
    </SiteLayout>
  );
}
