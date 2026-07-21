import { Star, ExternalLink, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { GOOGLE_REVIEWS_URL, hasPlaceholderContent, type Quote } from "@/lib/testimonials";

// ⚠️ These are NOT real reviews — they only exist so the layout can be built and
// reviewed. Fabricated testimonials must never go live. To launch: replace every
// quote below with a real Google review (reviewer first name + text) and set
// `rating` / `reviewCount` to the club's real figures. There is no flag to flip —
// the "placeholder" warning is derived from the marker text, so it disappears on
// its own once the markers are gone.
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
  const isPlaceholder = hasPlaceholderContent(quotes, rating, reviewCount);

  return (
    <div className={cn(className)}>
      {isPlaceholder && (
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
              isPlaceholder && "border-dashed",
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
