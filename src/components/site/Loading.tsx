import { cn } from "@/lib/utils";

/**
 * The "this has not arrived yet" line, for the screens that show a plain one
 * rather than `AuthPending`'s full-page spinner.
 *
 * The markup is the point. Dozens of screens rendered the same bare
 * `Loading...` text with no live region, so a screen-reader user got no signal
 * that the page had started fetching or had finished: the text simply appeared
 * and vanished with nothing announcing either. `role="status"` plus
 * `aria-live="polite"` is what `AuthPending` and `SubmitStatus` already do, and
 * this is that same wiring for a one-line state.
 */
export function Loading({
  label = "Loading...",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <p role="status" aria-live="polite" className={cn("text-sm text-muted-foreground", className)}>
      {label}
    </p>
  );
}
