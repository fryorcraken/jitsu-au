import { createFileRoute } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteLayout";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { faqItems } from "@/lib/faq";

export const Route = createFileRoute("/faq")({
  head: () => ({
    meta: [
      { title: "FAQ | UTS Jitsu" },
      {
        name: "description",
        content: "Answers to common questions about starting Japanese Jiu-Jitsu at UTS Jitsu.",
      },
      { property: "og:title", content: "FAQ | UTS Jitsu" },
      { property: "og:description", content: "Trial classes, gear, experience needed, and more." },
      { property: "og:url", content: "https://jitsu.au/faq" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/faq" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqItems.map((q) => ({
            "@type": "Question",
            name: q.q,
            acceptedAnswer: { "@type": "Answer", text: q.a },
          })),
        }),
      },
    ],
  }),
  component: Faq,
});

function Faq() {
  return (
    <SiteLayout>
      <section className="mx-auto max-w-3xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">FAQ</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">Frequently asked questions</h1>
        <p className="mt-4 text-muted-foreground">
          Can't find what you're looking for?{" "}
          <a className="text-primary underline underline-offset-4" href="/contact">
            Contact us
          </a>
          .
        </p>
        <Accordion type="single" collapsible className="mt-8">
          {faqItems.map((item, i) => (
            <AccordionItem value={`item-${i}`} key={item.q}>
              <AccordionTrigger className="text-left text-base font-semibold">
                {item.q}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground">{item.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
    </SiteLayout>
  );
}
