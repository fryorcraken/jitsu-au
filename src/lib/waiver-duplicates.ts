// Duplicate detection for paper waiver filing.
//
// Filing a waiver is unlimited by design — someone can sign as many as they
// like, and the club keeps every one. What is NOT intended is the same piece of
// paper landing twice: a retried import batch, or a manager re-uploading
// because they could not tell whether the first attempt went through. Each copy
// is another pending row a manager could approve, and a person's ACTIVE waiver
// is their most recently APPROVED one, so which duplicate got approved decides
// what the club's insurance record says. That is worth a speed bump.
//
// It is a speed bump, not a wall: a corrected re-scan of the same signing date
// is a real thing a manager does, so the caller can say "yes, both" and file it.
// Pure and side-effect free so both entry points (the manager web form and the
// agent API) can share the wording and the shape.

/** An already-filed waiver that the incoming one looks like a copy of. */
export type DuplicateWaiverRef = {
  id: string;
  /** `pending` | `approved` — as stored on the row. */
  approval_status: string;
  /** The signing date on the paper, `YYYY-MM-DD`. */
  signed_on: string;
};

/**
 * The message a caller sees when a filing is blocked as a likely duplicate.
 * Names the existing rows so the caller can go and look at them rather than
 * guessing which of several near-identical waivers is meant.
 */
export function duplicateWaiverMessage(existing: DuplicateWaiverRef[], truncated = false): string {
  const count = existing.length;
  const date = existing[0]?.signed_on ?? "that date";
  const listed = existing.map((w) => `${w.id} (${w.approval_status})`).join(", ");
  // "at least" when the probe hit its cap: reporting a capped count as the total
  // would understate a mess at exactly the moment the caller most needs to know
  // how big it is.
  const howMany = `${truncated ? "at least " : ""}${count} waiver${count === 1 ? "" : "s"}`;
  return (
    `This person already has ${howMany} signed on ${date}: ${listed}. ` +
    "Filing this one would add another copy of the same paperwork. " +
    "If it is a corrected re-scan and you mean to keep both, send it again with confirm_duplicate set to true."
  );
}

/**
 * Thrown by `filePaperWaiver` when the person already has a waiver with the
 * same signing date and the caller has not confirmed. Carries the existing rows
 * so each surface can present them its own way: the agent API returns them in
 * the error payload, the manager's upload form offers a "file it anyway" step.
 */
export class DuplicateWaiverError extends Error {
  existing: DuplicateWaiverRef[];
  /** True when more same-date waivers exist than the probe returned. */
  truncated: boolean;

  constructor(existing: DuplicateWaiverRef[], truncated = false) {
    super(duplicateWaiverMessage(existing, truncated));
    this.name = "DuplicateWaiverError";
    this.existing = existing;
    this.truncated = truncated;
  }
}

/**
 * Thrown when the duplicate probe itself failed — a transient read error, not a
 * verdict about the waiver. Kept distinct from every other filing failure
 * because the right response differs: this one is "retry", where an unreadable
 * scan is "fix the file".
 *
 * Deliberately says nothing about `confirm_duplicate`. That flag does skip the
 * probe, but offering it as the remedy for an infrastructure error invites a
 * retry policy to set it on any failure, which would disable the check for a
 * genuine duplicate too. A caller who truly means to file unchecked can still
 * pass it; it just is not advice this error gives.
 */
export class DuplicateCheckFailedError extends Error {
  constructor() {
    super(
      "Could not check whether this waiver has already been filed, so nothing was filed. Try again.",
    );
    this.name = "DuplicateCheckFailedError";
  }
}

/**
 * The waiver row exists but its scan did not store, so the filing is unfinished
 * rather than failed. TRANSIENT: retrying with the same `client_submission_id`
 * resumes the row and completes it.
 *
 * Typed rather than a plain Error because the API maps it to a 5xx, and the
 * endpoint's own documented rule is that 5xx means "retry unchanged" while 4xx
 * means "change the request before retrying". Landing this in the generic 422
 * told a well-behaved caller to change something — and the only thing it could
 * reasonably change is the id, which files a second waiver against the same
 * paper and abandons the first.
 */
export class WaiverFilingIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaiverFilingIncompleteError";
  }
}

/**
 * The `client_submission_id` is already bound to a different record. PERMANENT:
 * the caller's id assignment is wrong and no retry of this request will ever
 * succeed, which is the opposite of the error above and must not share its code.
 */
export class SubmissionIdConflictError extends Error {
  constructor() {
    super(
      "That client_submission_id already belongs to a different waiver. Mint a new id per record, and resend the same id only when retrying that record.",
    );
    this.name = "SubmissionIdConflictError";
  }
}

/**
 * Project the rows the duplicate query returns into the shared reference shape.
 * `signed_at` is stored as midnight UTC on the signing date (filePaperWaiver
 * writes it that way), so the date part is the date on the paper.
 */
export function toDuplicateRefs(
  rows: { id: string; approval_status: string | null; signed_at: string }[],
): DuplicateWaiverRef[] {
  return rows.map((r) => ({
    id: r.id,
    approval_status: r.approval_status ?? "pending",
    signed_on: r.signed_at.slice(0, 10),
  }));
}
