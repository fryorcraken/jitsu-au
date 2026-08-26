import { CloudOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeWhen } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * "This is what your phone had. We could not check for anything newer."
 *
 * Shown when a screen is rendering a copy kept on the device
 * (`usePersistentQuery`) and the refresh behind it failed. Both halves matter:
 * without the cache the screen would be an error panel, and without this notice
 * it would be a confident, possibly out-of-date answer with no way to tell.
 *
 * The counterpart to `LoadFailure`, which is for a load that produced NOTHING.
 * This one is for a load that produced something slightly old, so it is a note
 * beside the content rather than a panel in place of it, and it is `status`
 * rather than `alert`: nothing is broken, the screen is just behind.
 */
export function StaleNotice({
  savedAt,
  what,
  onRetry,
  className,
}: {
  /** Epoch ms the copy on screen was fetched. */
  savedAt: number;
  /** What is being shown, in the reader's words: "roster", "article". */
  what: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm",
        className,
      )}
    >
      <CloudOff className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">
        Showing the {what} saved on this device at {describeWhen(savedAt)}. We could not reach the
        site to check for anything newer.
      </span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}
