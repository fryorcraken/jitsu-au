import { Star, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { GOOGLE_RATING, GOOGLE_REVIEWS, GOOGLE_REVIEWS_URL } from "@/lib/google-reviews";

function RatingBadge() {
  return (
    <a
      href={GOOGLE_REVIEWS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-full border bg-background px-4 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
    >
      <Star className="h-4 w-4 fill-primary text-primary" aria-hidden />
      <span>{GOOGLE_RATING} on Google</span>
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
        {GOOGLE_REVIEWS.map((q) => (
          <figure key={q.name} className="flex flex-col rounded-2xl border bg-card p-6">
            <Stars />
            <blockquote className="mt-4 flex-1 text-sm leading-relaxed text-muted-foreground">
              &ldquo;{q.text}&rdquo;
            </blockquote>
            <figcaption className="mt-4 text-sm font-semibold">
              {q.name}
              <span className="ml-2 font-normal text-muted-foreground">Google review</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
