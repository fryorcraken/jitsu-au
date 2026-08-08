// The two branches this module's own doc comment calls non-guessable, and which
// nothing covered before: a failed read must NOT write, and an unchanged marker
// must NOT write.
//
// Both matter because a watermark can only be wrong in one direction safely.
// Moving it forward on bad information silently marks things seen that nobody
// saw; leaving it where it is only costs a badge that clears next visit. The
// arithmetic underneath (`advanceSeenMarker`) is pure and covered in
// validation.test.ts; what is tested here is whether the write happens at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

import {
  CONTACT_SEEN_KEY,
  INTEREST_SEEN_KEY,
  readSeenMarker,
  stampSeenMarker,
} from "./seen-markers";

type Row = { value: string } | null;

/** A `club_settings` stub: one read result, and a record of any upsert. */
function fakeAdmin(read: { data: Row; error: { message: string } | null }) {
  const upserts: unknown[] = [];
  const keysRead: unknown[] = [];
  const admin = {
    from() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (_col: string, key: unknown) => {
          keysRead.push(key);
          return chain;
        },
        maybeSingle: () => Promise.resolve(read),
        upsert: (row: unknown) => {
          upserts.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, upserts, keysRead };
}

const EARLIER = "2026-08-05T09:00:00.000Z";
const LATER = "2026-08-05T11:00:00.000Z";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("readSeenMarker", () => {
  it("reports a failed read rather than passing it off as 'never set'", async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: "boom" } });
    // The two callers need opposite things from this. Counting degrades to
    // "everything is new"; stamping must not, because treating a failed read as
    // "never set" skips the only-moves-forward guard.
    expect(await readSeenMarker(admin, CONTACT_SEEN_KEY)).toEqual({ marker: null, failed: true });
  });

  it("treats a blank value as unset, and reads the key it was given", async () => {
    const { admin, keysRead } = fakeAdmin({ data: { value: "   " }, error: null });
    expect(await readSeenMarker(admin, INTEREST_SEEN_KEY)).toEqual({ marker: null, failed: false });
    // The two watermarks share this module and must not share a row.
    expect(keysRead).toEqual([INTEREST_SEEN_KEY]);
    expect(CONTACT_SEEN_KEY).not.toBe(INTEREST_SEEN_KEY);
  });
});

describe("stampSeenMarker", () => {
  it("does not write when the current marker could not be read", async () => {
    const { admin, upserts } = fakeAdmin({ data: null, error: { message: "boom" } });
    // Writing here is the one way this can lose ground: with nothing to compare
    // against, the only-moves-forward guard is unavailable. Leaving the badge up
    // is the safe direction.
    expect(await stampSeenMarker(admin, CONTACT_SEEN_KEY, LATER, "manager-1")).toEqual({
      marker: null,
      skipped: true,
    });
    expect(upserts).toEqual([]);
  });

  it("does not write when the marker would not move", async () => {
    const { admin, upserts } = fakeAdmin({ data: { value: LATER }, error: null });
    // A stale tab finishing late must not drag the marker back and make
    // already-read things reappear.
    expect(await stampSeenMarker(admin, CONTACT_SEEN_KEY, EARLIER, "manager-1")).toEqual({
      marker: LATER,
      skipped: true,
    });
    expect(upserts).toEqual([]);
  });

  it("writes the key, the value and who moved it when it does move", async () => {
    const { admin, upserts } = fakeAdmin({ data: { value: EARLIER }, error: null });
    expect(await stampSeenMarker(admin, INTEREST_SEEN_KEY, LATER, "manager-1")).toEqual({
      marker: LATER,
      skipped: false,
    });
    expect(upserts).toEqual([
      expect.objectContaining({
        key: INTEREST_SEEN_KEY,
        value: LATER,
        updated_by: "manager-1",
      }),
    ]);
  });

  it("never stamps the future, whatever boundary it is handed", async () => {
    const { admin, upserts } = fakeAdmin({ data: { value: EARLIER }, error: null });
    const result = await stampSeenMarker(admin, CONTACT_SEEN_KEY, "2099-01-01T00:00:00.000Z", "m1");
    // Marking things read before they arrive is the one failure that loses
    // something for good, so the candidate is clamped to now.
    expect(new Date(String(result.marker)).getTime()).toBeLessThanOrEqual(Date.now());
    expect(upserts).toHaveLength(1);
  });
});
