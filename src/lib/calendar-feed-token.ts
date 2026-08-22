// What the ICS feed route does with the token it was handed.
//
// Pulled out of the route so the rule that matters can be tested without a
// request: a link its owner has REPLACED must never serve events again, and it
// must say why rather than answering like a typo.
//
// Why replacing exists at all: the token rides in the URL path because a
// calendar app subscribes to an address and has nowhere else to put a
// credential. It can never move to a header, so it is the longest-lived secret
// on the site, and minting a fresh one is the only lever a member has if theirs
// ends up somewhere it should not be. See docs/calendar.md.

/** All the verdict reads off the row the feed route looked up by hash. */
export type FeedTokenRow = { revoked_at: string | null };

export type FeedTokenVerdict<T> =
  | { serve: true; row: T }
  | { serve: false; status: number; message: string };

/**
 * What someone gets from a link that has been replaced. Most calendar apps
 * swallow the body and simply stop syncing, but the person who pastes the old
 * URL into a browser to find out what happened gets a straight answer, and so
 * does the manager they ask about it.
 */
export const REPLACED_LINK_MESSAGE =
  "This calendar link was replaced, so it has stopped updating. Sign in at jitsu.au/account, copy your new calendar link, and add that one to your calendar app.";

/** Deliberately the same words for "never existed" and "mistyped". */
export const UNKNOWN_LINK_MESSAGE = "Calendar not found.";

/**
 * Decide whether a token may still be served a calendar.
 *
 * A replaced link answers 410 rather than 404: the address was real and is now
 * permanently gone, which is a different thing from never having existed, and
 * it is what lets the message above be honest. Saying "replaced" to whoever
 * holds the old token gives nothing away, since holding it was the only way to
 * ask in the first place.
 */
export function feedTokenVerdict<T extends FeedTokenRow>(row: T | null): FeedTokenVerdict<T> {
  if (!row) return { serve: false, status: 404, message: UNKNOWN_LINK_MESSAGE };
  if (row.revoked_at) return { serve: false, status: 410, message: REPLACED_LINK_MESSAGE };
  // Carries the row through so the caller keeps it non-null without a second
  // check that could only ever be dead code.
  return { serve: true, row };
}
