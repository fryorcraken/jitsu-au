import { Button } from "@/components/ui/button";

/**
 * The buttons under every editable card.
 *
 * Save stays disabled until something actually differs from what is stored, so
 * the button tells the member whether they have unsaved work rather than
 * inviting a no-op write. Revert only appears once there is something to
 * revert: before this, the only way out of a half-typed change was reloading
 * the page, which is not an affordance anybody should have to guess.
 */
export function CardActions({
  dirty,
  busy,
  onRevert,
}: {
  dirty: boolean;
  busy: boolean;
  onRevert: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" disabled={busy || !dirty}>
        {busy ? "Saving..." : "Save"}
      </Button>
      {dirty && !busy ? (
        <Button type="button" variant="outline" onClick={onRevert}>
          Revert
        </Button>
      ) : null}
      {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
    </div>
  );
}
