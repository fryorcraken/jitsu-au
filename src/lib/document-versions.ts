// What is true of every document the club keeps in numbered versions, one of
// them live: the waiver people sign and the code of conduct members agree to.
// The knowledge base's articles borrow the version label too, though they keep
// their own per-article promotion (`kb-admin.ts`).
//
// Each of those has rules of its own (the waiver's acknowledgements, the code
// of conduct's re-agreement choice), which stay in their own modules. What is
// here is the part they share and must not drift on: how a refused change is
// described, so the screens and the manager agent API branch on it the same
// way, and what a version is called in a list.
//
// Pure: no React, no server calls, no Supabase client. The database half of the
// same idea (promoting a version without leaving the club with none live) is
// `document-version-store.ts`.

/**
 * Why a change to a versioned document could not be made.
 *
 * One class carrying a reason rather than three classes, because the callers
 * that care all branch on the same three cases: an editor screen shows the
 * message either way, and the agent API turns the reason into a status code an
 * agent can act on (change the request / it is gone / try again).
 *
 * `not_published` is the one a message alone cannot carry. It means the club's
 * live version is not what the caller asked for, and when `version` is set it
 * means that version WAS written and is simply not live — so repeating the save
 * files a second numbered draft, while publishing that version finishes the job.
 * Getting that distinction wrong is how an outage (`/waiver` refusing to render
 * for everyone) gets reported as "your request was invalid" and abandoned.
 */
export class DocumentVersionError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "invalid" | "not_published",
    /**
     * The version that exists but is not live. Undefined when nothing was
     * written at all, which is the difference between "retry this call" and
     * "publish the version you already have".
     */
    readonly version?: number,
  ) {
    super(message);
    this.name = "DocumentVersionError";
  }
}

/**
 * How a version is labelled in the list.
 *
 * "Draft" is only honest for a version that has never been live. One that WAS
 * live is a superseded document, possibly with signatures against it, and
 * calling it a draft on the screen where a manager picks what the club stands
 * behind invites treating a rollback as publishing something unfinished.
 *
 * `wasLive` is the answer when the document records it (the code of conduct
 * stamps `first_published_at`): a version rolled away from is newer than the
 * live one and was still live once. Where it is not recorded (the waiver, the
 * knowledge base), age against the live version stands in: anything older than
 * what is live has had its turn, and a rolled-back newer version reads "Draft".
 */
export function versionLabel(
  version: { version: number; is_current: boolean },
  liveVersion: number | null,
  wasLive?: boolean,
): "Live" | "Previous" | "Draft" {
  if (version.is_current) return "Live";
  if (wasLive) return "Previous";
  if (wasLive === undefined && liveVersion !== null && version.version < liveVersion)
    return "Previous";
  return "Draft";
}
