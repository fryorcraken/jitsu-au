// These schemas decide what the door screen shows when there is no signal, so
// they have to describe what the server really returns — and they have to keep
// working when a new warning code or a new field is added, because a schema that
// rejects those empties the cache it exists to fill.
import { describe, expect, it } from "vitest";
import {
  CHECKIN_CACHE_MAX_AGE_MS,
  checkInBoardCacheSchema,
  checkInEventsCacheSchema,
  knownCheckInWarnings,
} from "@/lib/checkin-cache";
import { KB_CACHE_MAX_AGE_MS } from "@/lib/kb-cache";

const event = {
  id: "event-1",
  title: "Beginners",
  instructor_name: "Sam",
  location: "UTS Ultimo",
  starts_at: "2026-08-26T08:00:00Z",
  ends_at: "2026-08-26T09:30:00Z",
  status: "scheduled",
};

const board = {
  event,
  roster: [
    {
      user_id: "user-1",
      name: "Jane L.",
      email: "jane@example.com",
      coverage: "trial",
      plan_name: "Free trial",
      sessions_remaining_before: 2,
      consumes_credit: true,
      warnings: ["last_credit"],
    },
  ],
  checkins: [
    {
      id: "checkin-1",
      user_id: "user-1",
      name: "Jane L.",
      checked_in_at: "2026-08-26T08:02:00Z",
      coverage: "none",
      plan_name: null,
      consumed_credit: false,
      warnings: ["no_cover"],
    },
  ],
};

describe("checkInEventsCacheSchema", () => {
  it("accepts a real class list", () => {
    expect(checkInEventsCacheSchema.safeParse([{ ...event, checked_in_count: 4 }]).success).toBe(
      true,
    );
  });

  it("accepts an empty list, which is a real answer", () => {
    expect(checkInEventsCacheSchema.safeParse([]).success).toBe(true);
  });

  it("rejects a list whose fields have changed type", () => {
    expect(checkInEventsCacheSchema.safeParse([{ ...event, checked_in_count: "4" }]).success).toBe(
      false,
    );
  });
});

describe("checkInBoardCacheSchema", () => {
  it("accepts a real roster", () => {
    expect(checkInBoardCacheSchema.safeParse(board).success).toBe(true);
  });

  it("accepts every coverage the app can produce", () => {
    for (const coverage of ["trial", "session", "period", "none"]) {
      const one = { ...board, roster: [{ ...board.roster[0], coverage }] };
      expect(checkInBoardCacheSchema.safeParse(one).success).toBe(true);
    }
  });

  it("rejects a coverage the app does not know", () => {
    const one = { ...board, roster: [{ ...board.roster[0], coverage: "freebie" }] };
    expect(checkInBoardCacheSchema.safeParse(one).success).toBe(false);
  });

  it("accepts every warning code the app has today", () => {
    const one = { ...board, roster: [{ ...board.roster[0], warnings: [...knownCheckInWarnings] }] };
    expect(checkInBoardCacheSchema.safeParse(one).success).toBe(true);
  });

  it("accepts a warning code it has never seen", () => {
    // Deliberate. Warnings are stored as codes precisely so the wording can
    // change without a migration, and the screen prints an unknown one
    // verbatim. Pinning the enum here would invalidate every stored roster on
    // every phone the day a new code shipped.
    const one = { ...board, roster: [{ ...board.roster[0], warnings: ["brand_new_code"] }] };
    expect(checkInBoardCacheSchema.safeParse(one).success).toBe(true);
  });

  it("rejects anything that is not a roster", () => {
    for (const value of [null, [], {}, { event }, "text"]) {
      expect(checkInBoardCacheSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("CHECKIN_CACHE_MAX_AGE_MS", () => {
  it("is a day, and shorter than the knowledge base's", () => {
    // The judgement written down in `checkin-cache.ts`: this one carries
    // members' names and emails and goes out of date between classes, so it
    // must never outlive the club's own prose.
    expect(CHECKIN_CACHE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(CHECKIN_CACHE_MAX_AGE_MS).toBeLessThan(KB_CACHE_MAX_AGE_MS);
  });
});
