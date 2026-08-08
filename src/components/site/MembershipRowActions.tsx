// Activate / Cancel / Delete for one membership, shared by the two manager
// screens that show them: the club-wide invoice list (/manager/memberships) and
// one person's page (/manager/users/<id>).
//
// Shared rather than duplicated because these buttons are not styling — they
// grant somebody membership, close it, or destroy a record. Two copies of that
// would be two places for the delete guard to drift, and the guard is the whole
// point of the delete button.
//
// The confirms say what will happen in words before the click, because both
// outward-facing actions here are ones somebody feels: activating emails the
// member and grants them the member label, deleting cannot be undone. A failure
// stays in the dialog with the button still there rather than becoming a toast
// that auto-dismisses on a phone.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { deleteMembership, setMembershipStatus } from "@/lib/membership.functions";
import { membershipDeleteMessage, whyMembershipCannotBeDeleted } from "@/lib/validation";

/** The fields both screens' membership rows carry, and all the guard needs. */
export type MembershipActionRow = {
  id: string;
  status: string;
  paid_at: string | null;
  checkin_count: number;
  plan_name: string | null;
};

type Pending = { kind: "activate" | "cancel" | "delete"; error: string | null; busy: boolean };

export function MembershipRowActions({
  membership,
  onChanged,
}: {
  membership: MembershipActionRow;
  /** Reload the caller's data. Awaited, so the dialog stays up until it lands. */
  onChanged: () => Promise<unknown>;
}) {
  const setStatus = useServerFn(setMembershipStatus);
  const remove = useServerFn(deleteMembership);
  const [pending, setPending] = useState<Pending | null>(null);

  // Computed here from the same pure rule the server enforces, so the button and
  // the refusal can never disagree about why. The server still re-checks: this
  // row was read at page load, and a class checked in since then must not be
  // deleted out from under.
  const blockers = whyMembershipCannotBeDeleted(membership);
  const canDelete = blockers.length === 0;

  async function run(kind: Pending["kind"]) {
    setPending({ kind, error: null, busy: true });
    try {
      if (kind === "delete") await remove({ data: { id: membership.id } });
      else
        await setStatus({
          data: { id: membership.id, status: kind === "activate" ? "active" : "cancelled" },
        });
      await onChanged();
      setPending(null);
    } catch (e) {
      // Stays on screen, in the dialog, with the button still there to press
      // again. This is the half of the flow a toast would lose.
      setPending({
        kind,
        busy: false,
        error: e instanceof Error ? e.message : "That did not go through. Try again.",
      });
    }
  }

  const copy = {
    activate: {
      title: `Activate ${membership.plan_name ?? "this membership"}?`,
      body: "This marks it paid, emails them that their membership is active, and lists them as a member. There is no undo email.",
      confirm: "Activate",
      destructive: false,
    },
    cancel: {
      title: `Cancel ${membership.plan_name ?? "this membership"}?`,
      body: "This closes the membership and keeps the record. If it was their only paid one, they lose the members-only calendar and blog comments, and stop being listed as a member.",
      confirm: "Cancel membership",
      destructive: false,
    },
    delete: {
      title: `Delete ${membership.plan_name ?? "this membership"}?`,
      body: "This removes the invoice completely, as though it had never been raised. It cannot be undone. To close a membership and keep the record, cancel it instead.",
      confirm: "Delete",
      destructive: true,
    },
  }[pending?.kind ?? "cancel"];

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {membership.status !== "active" && (
          <Button
            size="sm"
            onClick={() => setPending({ kind: "activate", error: null, busy: false })}
          >
            <Check className="mr-1 h-3 w-3" /> Activate
          </Button>
        )}
        {membership.status !== "cancelled" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPending({ kind: "cancel", error: null, busy: false })}
          >
            <Undo2 className="mr-1 h-3 w-3" /> Cancel
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!canDelete}
          // A disabled button that says nothing is a dead end. The reason rides
          // on the title so it is readable on a laptop, and is repeated as
          // screen-reader text below so it is not hover-only.
          title={canDelete ? undefined : membershipDeleteMessage(blockers)}
          onClick={() => setPending({ kind: "delete", error: null, busy: false })}
        >
          <Trash2 className="mr-1 h-3 w-3" /> Delete
        </Button>
        {!canDelete && <span className="sr-only">{membershipDeleteMessage(blockers)}</span>}
      </div>

      <AlertDialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open && !pending?.busy) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {pending?.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {pending.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending?.busy}>Go back</AlertDialogCancel>
            <AlertDialogAction
              className={
                copy.destructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              disabled={pending?.busy}
              // Not the default form-submitting close: the dialog has to stay
              // open to show a failure.
              onClick={(e) => {
                e.preventDefault();
                if (pending) void run(pending.kind);
              }}
            >
              {pending?.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pending?.error ? "Try again" : copy.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
