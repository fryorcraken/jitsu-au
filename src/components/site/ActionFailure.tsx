import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The panel a screen shows when a press that changes a record did not go
 * through, or went only part of the way.
 *
 * The sibling of `LoadFailure` and `SaveFailure`, for a one-tap action rather
 * than a load or a form, and here for the same reason: a `toast.error` is not a
 * UI for anything that matters. Some of these failures leave something for a
 * person to do ("that membership is one session short", "the class is uncovered
 * for now: attach it"), and a toast that fades in four seconds, or is missed on
 * a phone at the door, leaves nobody knowing.
 *
 * No retry button, unlike its siblings. The message says what to do, and for
 * the failures that motivated it a retry is the wrong answer: the first half of
 * the action already happened, so pressing again either finds nothing or argues
 * with the new state. It stays until it is dismissed or the next action starts.
 *
 * `role="alert"` because it reports something that did not happen as asked,
 * and the list on screen may look no different either way.
 */
export function ActionFailure({
  title,
  message,
  onDismiss,
  className,
}: {
  /** What did not go through, in the person's words: "Undoing that check-in did not finish." */
  title: string;
  /** Whatever the failure itself said, which says what state it left. */
  message: string;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-destructive/40 bg-destructive/5 p-4", className)}
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
