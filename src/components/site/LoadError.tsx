import { Button } from "@/components/ui/button";

/**
 * A load that failed, kept on screen with a way out.
 *
 * The failure this exists to end: a page catches a fetch error into
 * `toast.error(...)` and then renders its empty state. The toast fades after a
 * few seconds and what is left is a screen that says there is nothing here.
 * "Nobody has signed a waiver" and "we could not read the waivers" look
 * identical, and only one of them is a reason to stop looking. On a phone the
 * toast is easy to miss entirely, so the two are often indistinguishable from
 * the first moment.
 *
 * So this stays until the load succeeds, says which list failed, and carries
 * the retry itself rather than making someone reload the page and lose where
 * they were. `manager.contact-messages.tsx` did this by hand and was the only
 * screen that did; this is that panel, moved somewhere the other twenty-odd can
 * use it.
 *
 * `role="alert"` rather than `role="status"`: a screen-reader user who has
 * moved on to another part of the page still needs to know the thing they were
 * waiting for is not coming.
 */
export function LoadError({
  /** What could not be loaded, as a person would say it: "The waivers". */
  what,
  /** The underlying message, when there is one worth showing. */
  detail,
  /**
   * What an empty result would have meant, so the two cannot be confused.
   * Skip it where the screen has no empty state to be mistaken for.
   */
  notEmpty,
  onRetry,
  retryLabel = "Try again",
}: {
  what: string;
  detail?: string | null;
  notEmpty?: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
      data-testid="load-error"
    >
      <p className="text-sm font-medium">{what} could not be loaded.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {detail ? `${detail} ` : ""}
        {notEmpty ?? "This is not the same as having nothing here."}
      </p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
