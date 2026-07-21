import { Star, ExternalLink, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// The club's Google reviews (source of truth for the quotes below).
export const GOOGLE_REVIEWS_URL = "https://maps.app.goo.gl/VhonWy3FDoyBpax59";

// ⚠️ PLACEHOLDER CONTENT — see issue #8.
//
// The quotes, rating and review count below are NOT real. They exist only so the
// layout can be built and reviewed. Fabricated testimonials must never go live.
//
// BEFORE PRODUCTION:
//   1. Replace `quotes` with 2–3 real reviews (reviewer first name + text) from
//      the Google reviews page above.
//   2. Set `rating` and `reviewCount` to the club's real current figures.
//   3. Flip `PLACEHOLDER` to `false`.
//
// While `PLACEHOLDER` is `true` the strip renders a loud, unmistakable warning so
// it can't be shipped by accident (a test also fails if placeholders reach prod).
export const PLACEHOLDER = true;

type Quote = { name: string; text: string };

const quotes: Quote[] = [
  {
    name: "[PLACEHOLDER reviewer]",
    text: "[PLACEHOLDER — replace with real Google review] Walked in as a total beginner and everyone made me feel welcome from the first class. The coaches break things down so it's easy to follow.",
  },
  {
    name: "[PLACEHOLDER reviewer]",
    text: "[PLACEHOLDER — replace with real Google review] I was nervous about trying a martial art but the free trial made it easy. No pressure, great people, and I actually learned something useful.",
  },
  {
    name: "[PLACEHOLDER reviewer]",
    text: "[PLACEHOLDER — replace with real Google review] Practical self-defence taught properly. Fitter than I've been in years and it never feels like a chore.",
  },
];

// Overall Google rating + number of reviews shown in the badge.
const rating = "5.0"; // [PLACEHOLDER] — replace with the real overall rating
const reviewCount = "N"; // [PLACEHOLDER] — replace with the real review count

function RatingBadge() {
  return (
    <a
      href={GOOGLE_REVIEWS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-full border bg-background px-4 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
    >
      <Star className="h-4 w-4 fill-primary text-primary" aria-hidden />
      <span>
        {rating} on Google · {reviewCount} reviews
      </span>
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
      {PLACEHOLDER && (
        <div
          role="alert"
          className="mb-6 flex items-center gap-2 rounded-lg border-2 border-dashed border-amber-500 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          Placeholder testimonials — not real reviews. Replace before launch (issue #8).
        </div>
      )}

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
          <figure
            key={q.name + q.text.slice(0, 16)}
            className={cn(
              "flex flex-col rounded-2xl border bg-card p-6",
              PLACEHOLDER && "border-dashed",
            )}
          >
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
