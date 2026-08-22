import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  /**
   * What did not arrive, in the reader's words: "The contact messages". The
   * component writes the sentence around it, so every screen says it the same
   * way.
   */
  what: string;
  /** Whatever the failure itself said. Shown as-is when there is one. */
  message?: string | null;
  /**
   * The line that stops a broken load reading as an empty one: "This is not the
   * same as having no messages." Worth writing per screen, because what the
   * empty state would have claimed differs every time.
   */
  hint?: ReactNode;
  onRetry: () => void;
  /** Extra content under the message, above the button. */
  children?: ReactNode;
  className?: string;
};

/**
 * The panel a screen shows in place of its content when the content could not
 * be fetched.
 *
 * This exists because a `toast.error` is not a UI for a failed load. It fades,
 * and what it leaves behind is the ordinary empty state: no messages, no
 * members, everything reconciled. A manager who looks away for four seconds is
 * then reading a confident, wrong answer with no way to tell and nothing to
 * press. So the failure stays on screen, says it is not the same as having
 * nothing, and carries the retry.
 *
 * `role="alert"` for the same reason `SubmitStatus` carries one: this replaces
 * content that was expected to appear, and a screen-reader user gets no other
 * signal that it did not.
 */
export function LoadFailure({ what, message, hint, onRetry, children, className }: Props) {
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-destructive/40 bg-destructive/5 p-4", className)}
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        {what} could not be loaded.
      </p>
      {(message || hint) && (
        <p className="mt-1 text-sm text-muted-foreground">
          {message ? `${message} ` : ""}
          {hint}
        </p>
      )}
      {children}
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}
