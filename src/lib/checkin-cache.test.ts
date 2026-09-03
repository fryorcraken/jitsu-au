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
      guardian_name: null,
      age: null,
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

  // What tells two siblings apart at the door. Zod STRIPS what the schema does
  // not name, so a field missing from here is not a no-op: it is a silent loss
  // on exactly the offline relaunch this cache exists for.
  it("keeps the fields that tell one child from another", () => {
    const child = { ...board.roster[0], guardian_name: "Ada Lovelace", age: 10 };
    const parsed = checkInBoardCacheSchema.parse({ ...board, roster: [child] });
    expect(parsed.roster[0].guardian_name).toBe("Ada Lovelace");
    expect(parsed.roster[0].age).toBe(10);
  });

  // The roster is kept on a manager's own device and, for a class already
  // taught, is never read again and so never pruned. The server sends an age
  // rather than a date of birth precisely so nothing here can outlive its
  // usefulness as an identity-document field: a stray one is stripped.
  it("stores no date of birth, even if one is handed to it", () => {
    const child = {
      ...board.roster[0],
      guardian_name: "Ada Lovelace",
      age: 10,
      date_of_birth: "2016-04-02",
    };
    const parsed = checkInBoardCacheSchema.parse({ ...board, roster: [child] });
    expect(JSON.stringify(parsed)).not.toContain("2016-04-02");
    expect(parsed.roster[0]).not.toHaveProperty("date_of_birth");
  });

  // A board cached by the version before those fields existed. Required, they
  // would fail the whole schema and throw away a manager's stored roster on
  // their first load after a deploy, at the door and offline.
  it("still restores a roster cached before those fields existed", () => {
    const { guardian_name: _g, age: _a, ...old } = board.roster[0];
    const parsed = checkInBoardCacheSchema.safeParse({ ...board, roster: [old] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.roster[0].guardian_name).toBeNull();
      expect(parsed.data.roster[0].age).toBeNull();
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
