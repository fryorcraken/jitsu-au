// A member's private calendar link, and the one thing they can do to it.
//
// Shared by /calendar, where the link has always lived, and /account, where you
// go when something needs doing. Both show the same link and offer the same
// replace, so they are one component: two copies would be two places for the
// warning to drift, and the warning is the whole point of the button.
//
// Replacing is irreversible and it breaks something on purpose, so it goes
// through a real confirm that says in words what will stop working. The new
// link then stays on screen with a copy button, because this is the only moment
// it exists in front of the person and their calendar app is out of date until
// they paste it somewhere. A toast would take it away again while they were
// still unlocking their phone.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/site/CopyButton";
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
import { getMyCalendarFeedUrl, replaceMyCalendarFeedUrl } from "@/lib/calendar.functions";

/** Open confirm, mid-flight, or failed with something to press again. */
type Pending = { busy: boolean; error: string | null };

export function CalendarLinkPanel() {
  const loadFeedUrl = useServerFn(getMyCalendarFeedUrl);
  const replaceFeedUrl = useServerFn(replaceMyCalendarFeedUrl);

  const [url, setUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Sticks around after the dialog closes: the person has to notice that the
  // link in front of them is not the one their calendar app is subscribed to.
  const [justReplaced, setJustReplaced] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(() => {
    setLoadFailed(false);
    loadFeedUrl()
      .then(({ url: fresh }) => setUrl(fresh))
      .catch(() => setLoadFailed(true));
  }, [loadFeedUrl]);

  useEffect(load, [load]);

  async function replace() {
    setPending({ busy: true, error: null });
    try {
      const { url: fresh } = await replaceFeedUrl();
      setUrl(fresh);
      setJustReplaced(true);
      setPending(null);
    } catch {
      // Stays in the dialog with the button still there. The message has to
      // cover both halves of a half-finished replace: it may have retired the
      // old link before it failed, and a reload is what settles which link they
      // actually hold now.
      setPending({
        busy: false,
        error:
          "That didn't go through. Reload this page to see which link you have now, and try again if it hasn't changed.",
      });
    }
  }

  if (loadFailed) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground" role="status">
          We couldn't load your calendar link just now. Nothing has changed.
        </p>
        <Button size="sm" variant="outline" onClick={load}>
          Try again
        </Button>
      </div>
    );
  }

  if (!url) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading your link...
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded bg-background px-3 py-2 text-xs">
          {url}
        </code>
        <CopyButton text={url} label="Copy" ariaLabel="Copy your calendar link" />
      </div>

      {justReplaced && (
        <p
          role="status"
          className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
        >
          This is your new link. The old one has stopped working, so add this one to your calendar
          app now.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPending({ busy: false, error: null })}
        >
          Replace link
        </Button>
        <span className="text-xs text-muted-foreground">
          Use this if your link has ended up somewhere it shouldn't.
        </span>
      </div>

      <AlertDialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open && !pending?.busy) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your calendar link?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current link stops working straight away. Every calendar app you added it to
              stops updating until you put the new link in, and anyone you gave the old one to loses
              it. We'll show you the new link here as soon as it's ready.
            </AlertDialogDescription>
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
            <AlertDialogCancel disabled={pending?.busy}>Keep my link</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending?.busy}
              // Not the default form-submitting close: the dialog has to stay
              // open to show a failure.
              onClick={(e) => {
                e.preventDefault();
                void replace();
              }}
            >
              {pending?.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pending?.error ? "Try again" : "Replace link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default CalendarLinkPanel;
