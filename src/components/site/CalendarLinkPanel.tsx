// A member's private calendar link: fetched, shown in full, and copyable.
//
// Lifted out of /calendar unchanged. It is here because /account is about to
// show the same link, and the panel is not styling: it is a live-region loading
// state, a failure that stays on screen with a retry, and a URL that is the
// most sensitive string this app ever prints. Two copies of that would be two
// places for one of them to drift.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/site/CopyButton";
import { getMyCalendarFeedUrl } from "@/lib/calendar.functions";

export function CalendarLinkPanel() {
  const loadFeedUrl = useServerFn(getMyCalendarFeedUrl);

  const [url, setUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    loadFeedUrl()
      .then(({ url: fresh }) => setUrl(fresh))
      .catch(() => setLoadFailed(true));
  }, [loadFeedUrl]);

  useEffect(load, [load]);

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
    </div>
  );
}

export default CalendarLinkPanel;
