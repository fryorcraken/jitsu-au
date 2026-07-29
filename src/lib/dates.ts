// Date formatting for the manager and member screens.
//
// Shared for the same reason the status colours are: two copies of `fmtDate`
// had already drifted, so a missing date read "none" on the user list and "—"
// on the person page. "—" wins because it is what every other table in the app
// puts in an empty cell.
//
// Keep this module free of side effects and server-only imports so it stays
// unit-testable, mirroring `validation.ts`.

/** What an empty cell shows. */
export const EMPTY = "—";

/** A timestamp as a date: `29/07/2026`. */
export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU") : EMPTY;
}

/** A timestamp with its time of day: `29/07/2026, 2:57:18 pm`. */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString("en-AU") : EMPTY;
}

/**
 * A `DATE` column, which arrives as `YYYY-MM-DD`. `new Date` would read that as
 * UTC midnight and shift it a day back for anyone in a negative-offset
 * timezone, so format the parts directly: a birth date has no timezone.
 */
export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : value;
}
