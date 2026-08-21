// The app's hard stop: one question, asked in the app's own dialog, before an
// action that cannot be taken back.
//
// This exists because the alternative in this codebase was `window.confirm()`,
// which CLAUDE.md's UX bar bans outright. That ban is not about looks. A
// browser confirm blocks the whole tab, ignores the theme, is cramped and
// unreadable on the phones most of this club's traffic comes from, and Chrome
// will offer to suppress every later one after a couple in a row. Losing the
// one dialog that matters to a checkbox somebody ticked to get rid of the ones
// that did not is exactly the failure this repo is trying to avoid.
//
// The API is a promise rather than a `pendingX` state plus a block of JSX
// because most of these questions are asked in the MIDDLE of a flow ("you have
// unsaved changes", "this widens who can read it"), where the old code read
// `if (!window.confirm(...)) return;`. Keeping that shape means each call site
// stays a two-line edit instead of being turned inside out, and the wording
// stays next to the action it is about.
//
// Two dialogs deliberately do NOT use this: `MembershipRowActions` and
// `manager.blog.tsx` already ask with the same `AlertDialog` primitive, and the
// first has to stay open to show a failure and offer a retry, which a
// yes/no promise cannot express. This is a replacement for `window.confirm`,
// not a second way to open a dialog.
//
// What NOT to put behind it: anything a second click undoes. Cancel, hide,
// reorder, unpublish-then-publish. Confirming everything teaches people to
// click through without reading, which is what makes the one confirm that
// matters stop working.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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

export type ConfirmRequest = {
  /** The question, as a question. */
  title: string;
  /** What going ahead does, in the person's words, not the system's. */
  description: ReactNode;
  /** One line per thing the action does. Rendered as a list under the description. */
  details?: string[];
  /** The part that should stop someone: what this cannot take back. */
  footnote?: ReactNode;
  /** The button that goes ahead. Name the action, never "OK". */
  confirmLabel: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Paints the confirm button red. For deletes, not for merely serious things. */
  destructive?: boolean;
};

/**
 * Ask before an irreversible or outward-facing action.
 *
 * ```tsx
 * const { confirm, confirmDialog } = useConfirm();
 * // ...
 * if (!(await confirm({ title: "Delete this?", description: "...", confirmLabel: "Delete" })) ) return;
 * // ...
 * return <>{content}{confirmDialog}</>;
 * ```
 *
 * Cancelling, pressing Escape and clicking away all answer `false`, so the
 * caller only ever has to handle the two answers.
 */
export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  // `request` outlives `open` on purpose: Radix keeps the content mounted for
  // its close animation, and clearing the wording at the same moment would
  // flash an empty dialog on the way out.
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [open, setOpen] = useState(false);
  const resolveRef = useRef<((answer: boolean) => void) | null>(null);

  const settle = useCallback((answer: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setOpen(false);
    resolve?.(answer);
  }, []);

  const confirm = useCallback((next: ConfirmRequest) => {
    // A second question while one is still open would strand the first
    // caller's promise forever, and an awaited promise that never settles is a
    // flow that stops halfway with no error and nothing on screen. Answer the
    // old question "no" and let the new one take the dialog.
    resolveRef.current?.(false);
    setRequest(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  // Navigating away with a question open strands the caller the same way.
  useEffect(
    () => () => {
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(false);
    },
    [],
  );

  const confirmDialog = request ? (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription>{request.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {request.details?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {request.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {request.footnote ? (
          <p className="text-sm text-muted-foreground">{request.footnote}</p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {request.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            className={
              request.destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
            onClick={() => settle(true)}
          >
            {request.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  return { confirm, confirmDialog };
}
