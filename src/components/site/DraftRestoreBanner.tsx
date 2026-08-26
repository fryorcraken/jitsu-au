import { FileClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describeWhen } from "@/lib/dates";

/**
 * "You have unsaved work on this device. Want it back?"
 *
 * Shown by an editor when `useEditorDraft` finds something on the device that
 * differs from what the server last saved. It is an offer, not a restore: see
 * the note in `use-editor-draft.ts` about why a draft is never pushed back over
 * somebody's form on its own.
 *
 * `role="status"` rather than `alert`. Nothing is wrong — the opposite, in fact
 * — and this appears a moment after the page settles, which is exactly the case
 * a polite live region is for.
 */
export function DraftRestoreBanner({
  savedAt,
  what,
  onRestore,
  onDiscard,
  className,
}: {
  /** Epoch ms the draft was written. */
  savedAt: number | null;
  /** What was being written, in the person's words: "post", "article". */
  what: string;
  onRestore: () => void;
  onDiscard: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn("rounded-lg border border-primary/40 bg-primary/5 p-4", className)}
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <FileClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        You have an unsaved {what} on this device.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {savedAt ? `Kept from ${describeWhen(savedAt)}. ` : ""}
        It was never saved to the site, so nobody else can see it. Bringing it back replaces what is
        in the form now.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onRestore}>
          Bring it back
        </Button>
        <Button size="sm" variant="outline" onClick={onDiscard}>
          Discard it
        </Button>
      </div>
    </div>
  );
}
