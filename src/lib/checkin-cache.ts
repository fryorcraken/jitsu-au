// What the door screen is allowed to keep on the device.
//
// Check-in is run in a university gym, on a phone, by a manager with a queue of
// people in front of them and whatever reception the building allows. Opening
// the app to a spinner — or to "the roster could not be loaded" — is the failure
// that matters there, so the class list and the roster are kept on the device
// and shown immediately while a fresh copy is fetched behind them.
//
// **This one carries members' names and email addresses, so its terms are
// tighter than the knowledge base's.** Three things make it defensible:
//
//   * It is scoped to the manager who fetched it and wiped the moment anybody
//     signs out (`clearCacheFor` in `__root.tsx`), so a club laptop passed to
//     the next person carries nothing.
//   * It expires after a day rather than a week. Memberships are raised and
//     people sign waivers between classes; a roster older than that is not a
//     convenience, it is a wrong answer.
//   * When it IS the stored copy on screen, the screen says so
//     (`StaleNotice`) rather than presenting it as live.
//
// The **needs-attention list is deliberately NOT cached.** It is a worklist, and
// a stale one invites a manager to chase check-ins somebody already fixed. It
// stays memory-only and shows its ordinary empty state.
//
// Shapes are declared with Zod for the same reason the knowledge base's are —
// see the note at the top of `kb-cache.ts`.

import { z } from "zod";
import { checkInWarnings, coverageSources } from "./validation";

/** Bumped when a stored payload's meaning changes. Adding a field does not. */
export const CHECKIN_CACHE_VERSION = 1;

/**
 * How long a stored roster or class list is worth showing. See above: a day,
 * because the club's membership picture genuinely moves between classes.
 */
export const CHECKIN_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

// Warnings are stored as codes so their wording can change without a migration,
// and the screen already falls back to printing an unknown code verbatim. So
// this accepts any string rather than the enum: pinning it would make a NEW
// warning code invalidate every stored roster on every device.
const warning = z.string();
const coverage = z.enum(coverageSources);

const calendarEvent = z.object({
  id: z.string(),
  title: z.string(),
  instructor_name: z.string().nullable(),
  location: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: z.string(),
});

export const checkInEventsCacheSchema = z.array(
  calendarEvent.extend({ checked_in_count: z.number() }),
);

export const checkInBoardCacheSchema = z.object({
  event: calendarEvent,
  roster: z.array(
    z.object({
      user_id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      // Both null for everybody but a dependant. They are what tells two
      // siblings apart at the door, so a restored board that dropped them
      // would put a manager back in front of the ambiguity this cache is
      // meant to survive -- and Zod STRIPS what it does not name, so leaving
      // them out here is not a no-op, it is a silent loss on exactly the
      // offline relaunch the cache exists for.
      //
      // Defaulted rather than required, so a board cached by the version
      // BEFORE these existed still restores. Required, it would fail the whole
      // schema and throw away a manager's stored roster on their first load
      // after a deploy -- at the door, offline, which is the one moment this
      // cache is for. They arrive on the next successful fetch.
      guardian_name: z.string().nullable().default(null),
      // An AGE, never a date of birth. The server sends no date of birth for
      // anybody (`rosterHouseholdFields`), so none can be stored here: this
      // roster is kept on a manager's own device and is only pruned when it is
      // next read, which for a class already taught is never.
      age: z.number().nullable().default(null),
      coverage,
      plan_name: z.string().nullable(),
      sessions_remaining_before: z.number().nullable(),
      consumes_credit: z.boolean(),
      warnings: z.array(warning),
    }),
  ),
  checkins: z.array(
    z.object({
      id: z.string(),
      user_id: z.string(),
      name: z.string().nullable(),
      checked_in_at: z.string(),
      coverage,
      plan_name: z.string().nullable(),
      consumed_credit: z.boolean(),
      warnings: z.array(warning),
    }),
  ),
});

/** Re-exported so a test can assert the warning list is still the app's own. */
export const knownCheckInWarnings = checkInWarnings;
