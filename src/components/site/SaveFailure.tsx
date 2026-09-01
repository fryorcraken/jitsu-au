import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The panel a screen shows when a SAVE did not go through.
 *
 * The sibling of `LoadFailure`, and it exists for the same reason: a
 * `toast.error` is not a UI for anything that matters. It fades in four
 * seconds, and what it leaves behind is a form that looks exactly like one that
 * saved successfully. Somebody who glanced away walks off believing their work
 * is filed. On a phone, where the toast can be missed entirely, that is the
 * normal case rather than the unlucky one.
 *
 * So the failure stays on screen, says the work is still here, and carries the
 * button that tries again.
 *
 * `role="alert"` because this reports something that did not happen, and a
 * screen-reader user has no other signal: the form looks unchanged either way.
 */
export function SaveFailure({
  what,
  message,
  onRetry,
  retrying,
  keptOnDevice = true,
  className,
}: {
  /** What was being saved, in the person's words: "post", "article". */
  what: string;
  /** Whatever the failure itself said. */
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  /**
   * Whether a draft really is kept on the device (`useEditorDraft`).
   *
   * ⚠️ True by default because the three long-form editors this was written for
   * do keep one. Pass FALSE from a form that does not, or the panel makes a
   * promise the app cannot honour: a short form on a phone that the system
   * reclaims loses everything, having just told the person it was safe.
   */
  keptOnDevice?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-destructive/40 bg-destructive/5 p-4", className)}
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        This {what} was not saved.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {message}{" "}
        {keptOnDevice
          ? "Everything you have written is still on this screen and kept on this device, so nothing is lost."
          : "Everything you have typed is still on this screen, so nothing is lost."}{" "}
        Try again when you have a connection.
      </p>
      <Button className="mt-3" size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        {retrying ? "Saving..." : "Try again"}
      </Button>
    </div>
  );
}
