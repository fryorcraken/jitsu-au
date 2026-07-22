import { Star, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// The club's Google reviews. Swap the quotes/rating below for real ones when ready.
export const GOOGLE_REVIEWS_URL = "https://maps.app.goo.gl/VhonWy3FDoyBpax59";

const quotes = [
  {
    name: "Jane Doe",
    text: "I walked in never having done a martial art and left grinning. Everyone was patient and welcoming, and I booked my next class on the spot.",
  },
  {
    name: "John Doe",
    text: "The free trial made it easy to give it a go with zero pressure. Two months in and it's the highlight of my week.",
  },
  {
    name: "Joe Do",
    text: "Practical self-defence taught properly, and a genuinely friendly crew. Fitter and more confident already.",
  },
];

function RatingBadge() {
  return (
    <a
      href={GOOGLE_REVIEWS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-full border bg-background px-4 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
    >
      <Star className="h-4 w-4 fill-primary text-primary" aria-hidden />
      <span>5.0 on Google</span>
      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    </a>
  );
}

function Stars() {
  return (
    <div className="flex gap-0.5" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} className="h-4 w-4 fill-primary text-primary" />
      ))}
    </div>
  );
}

export function Testimonials({
  heading = "What our members say",
  className,
}: {
  heading?: string;
  className?: string;
}) {
  return (
    <div className={cn(className)}>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">
            Loved by beginners
          </p>
          <h2 className="mt-2 text-2xl font-bold md:text-3xl">{heading}</h2>
        </div>
        <RatingBadge />
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {quotes.map((q) => (
          <figure key={q.name} className="flex flex-col rounded-2xl border bg-card p-6">
            <Stars />
            <blockquote className="mt-4 flex-1 text-sm leading-relaxed text-muted-foreground">
              &ldquo;{q.text}&rdquo;
            </blockquote>
            <figcaption className="mt-4 text-sm font-semibold">{q.name}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
