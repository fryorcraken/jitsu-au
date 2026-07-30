import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { isInfrastructureBody, type SubmitFailureKind } from "@/lib/submit-resilience";
import type { ResilientSubmitStatus } from "@/hooks/use-resilient-submit";

type Props = {
  status: ResilientSubmitStatus;
  attempt: number;
  attempts: number;
  error: Error | null;
  failureKind: SubmitFailureKind | null;
  onRetry: () => void;
  /**
   * Form-specific reassurance shown alongside a hard failure, e.g. that a waiver
   * can also be signed at the gym. Somebody whose reception has just failed them
   * three times needs a way out that is not this page.
   */
  fallback?: ReactNode;
};

/**
 * The line under a submit button, and the panel that replaces it on failure.
 *
 * This is deliberately not a toast. A toast auto-dismisses, can be missed
 * entirely on a phone, and leaves nothing to press. The failure that matters
 * here is a waiver that did not get through, and the person needs to still be
 * looking at that fact ten seconds later, with a button under it.
 */
export function SubmitStatus({
  status,
  attempt,
  attempts,
  error,
  failureKind,
  onRetry,
  fallback,
}: Props) {
  if (status === "idle" || status === "succeeded" || status === "submitting") return null;

  if (status === "slow") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Still going. Your connection looks slow, so this can take a moment. Please keep this page
        open.
      </p>
    );
  }

  if (status === "confirming") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking whether that got through...
      </p>
    );
  }

  if (status === "retrying") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        That didn't get through. Trying again (attempt {Math.min(attempt + 1, attempts)} of{" "}
        {attempts}).
      </p>
    );
  }

  if (status === "offline") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <WifiOff className="h-3.5 w-3.5" />
        You're offline. We'll send this as soon as you're back, so leave this page open.
      </p>
    );
  }

  // status === "failed"
  //
  // A server refusal is something the person can act on (a missing tick, the
  // wrong email), so show what it said. Everything else is a connection problem,
  // where the message would be "Failed to fetch" and the useful thing to say is
  // that nothing was lost.
  //
  // The `isInfrastructureBody` guard is belt-and-braces on top of the classifier.
  // TanStack's client throws `new Error(await response.text())` for a response it
  // cannot parse, so a gateway page or this app's own HTML error page can arrive
  // as an ordinary Error. That must never be printed at somebody mid-way through
  // signing a waiver.
  const raw = error?.message ?? "";
  const isRefusal = failureKind === "server" && Boolean(raw) && !isInfrastructureBody(raw);
  return (
    <div
      className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
      role="alert"
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        {isRefusal ? raw : "We couldn't get through to us just now."}
      </p>
      {!isRefusal && (
        <p className="text-sm text-muted-foreground">
          Nothing you typed is lost. Check your signal and try again.
        </p>
      )}
      {fallback}
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
      </Button>
    </div>
  );
}
