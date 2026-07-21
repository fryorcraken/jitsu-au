import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { homepageFaqItems } from "@/lib/faq";

// Compact "greatest hits" of the FAQ, surfaced on the homepage where hesitation
// strikes. Content comes from the shared `@/lib/faq` source; the full list lives
// on /faq.
export function CommonQuestions() {
  return (
    <div>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">
            Common questions
          </p>
          <h2 className="mt-2 text-2xl font-bold md:text-3xl">Still wondering if it's for you?</h2>
        </div>
        <Link
          to="/faq"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          See all FAQs <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <Accordion type="single" collapsible className="mt-6">
        {homepageFaqItems.map((item, i) => (
          <AccordionItem value={`item-${i}`} key={item.id}>
            <AccordionTrigger className="text-left text-base font-semibold">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground">{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
