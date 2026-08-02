import { describe, expect, it } from "vitest";
import { DuplicateWaiverError, duplicateWaiverMessage, toDuplicateRefs } from "./waiver-duplicates";

describe("toDuplicateRefs", () => {
  it("reads the signing date off the stored midnight-UTC timestamp", () => {
    expect(
      toDuplicateRefs([
        { id: "w-1", approval_status: "approved", signed_at: "2026-03-14T00:00:00.000Z" },
      ]),
    ).toEqual([{ id: "w-1", approval_status: "approved", signed_on: "2026-03-14" }]);
  });

  it("reads a row with no approval status as pending, the state a filing lands in", () => {
    expect(
      toDuplicateRefs([
        { id: "w-1", approval_status: null, signed_at: "2026-03-14T00:00:00.000Z" },
      ])[0].approval_status,
    ).toBe("pending");
  });
});

describe("duplicateWaiverMessage", () => {
  const one = [{ id: "w-1", approval_status: "pending", signed_on: "2026-03-14" }];

  it("names the colliding waivers so the caller can go and look at them", () => {
    const msg = duplicateWaiverMessage(one);
    expect(msg).toMatch(/w-1 \(pending\)/);
    expect(msg).toMatch(/2026-03-14/);
  });

  it("points at the way past it, since a corrected re-scan is legitimate", () => {
    expect(duplicateWaiverMessage(one)).toMatch(/confirm_duplicate/);
  });

  it("agrees with itself about how many there are", () => {
    expect(duplicateWaiverMessage(one)).toMatch(/1 waiver signed/);
    expect(
      duplicateWaiverMessage([
        ...one,
        { id: "w-2", approval_status: "pending", signed_on: "2026-03-14" },
      ]),
    ).toMatch(/2 waivers signed/);
  });
});

describe("DuplicateWaiverError", () => {
  it("is a real Error carrying the rows it collided with", () => {
    const rows = [{ id: "w-1", approval_status: "pending", signed_on: "2026-03-14" }];
    const err = new DuplicateWaiverError(rows);
    expect(err).toBeInstanceOf(Error);
    expect(err.existing).toEqual(rows);
    expect(err.message).toBe(duplicateWaiverMessage(rows));
  });
});
