import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * "We are fetching this", said out loud.
 *
 * `AuthPending` already does this correctly for the whole-page case, and
 * `SubmitStatus` for a form that is writing. What neither covered was the
 * ordinary one: a signed-in screen fetching its list, which across this app was
 * written twenty-odd times as a bare `<div className="p-8">Loading...</div>`.
 *
 * Sighted users get the same information either way, which is why this went
 * unnoticed. A screen reader gets nothing at all from the bare version: no
 * announcement that the page started loading, and none when it finished, so the
 * only signal is silence followed by content that may or may not have arrived.
 *
 * `role="status"` with `aria-live="polite"` is the whole point of the
 * component. Everything else here is the spinner and the padding it replaced.
 */
export function LoadingPanel({
  label = "Loading",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-2 p-8 text-sm text-muted-foreground", className)}
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
