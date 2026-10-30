// Lookups by a list of ids, in slices.
//
// PostgREST renders `.in(column, ids)` into the request URL, and a few hundred
// UUIDs blow past the proxy's request-line limit, so the request fails outright
// rather than coming back short. Any `.in()` whose list can grow with the club
// (every date on the calendar, every member) goes through this.

/** How many ids one `.in()` filter carries. */
export const ID_CHUNK = 100;

/** `xs` in slices of at most `ID_CHUNK`, in order. Empty in, nothing out. */
export function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += ID_CHUNK) out.push(xs.slice(i, i + ID_CHUNK));
  return out;
}
