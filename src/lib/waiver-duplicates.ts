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
export function duplicateWaiverMessage(existing: DuplicateWaiverRef[]): string {
  const count = existing.length;
  const date = existing[0]?.signed_on ?? "that date";
  const listed = existing.map((w) => `${w.id} (${w.approval_status})`).join(", ");
  return (
    `This person already has ${count} waiver${count === 1 ? "" : "s"} signed on ${date}: ${listed}. ` +
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

  constructor(existing: DuplicateWaiverRef[]) {
    super(duplicateWaiverMessage(existing));
    this.name = "DuplicateWaiverError";
    this.existing = existing;
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
