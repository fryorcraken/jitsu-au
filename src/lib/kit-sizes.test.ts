import { describe, expect, it } from "vitest";
import {
  BELT_LENGTH_CM,
  GI_HEIGHT_CM,
  beltSizeForGiSize,
  beltSizeLabel,
  beltSizes,
  formatBeltSize,
  formatGiSize,
  giSizeLabel,
  giSizes,
  isBeltSize,
  isGiSize,
} from "./kit-sizes";

describe("kit-sizes charts", () => {
  // These two literals are duplicated in CHECK constraints on public.profiles
  // (profiles_gi_size_check / profiles_belt_size_check). Nothing in the suite
  // can read a CHECK, so pinning them here is the only thing that turns
  // "widened the array, forgot the migration" into a failing test rather than a
  // PostgREST 400 in production. Changing either list means writing a migration
  // that replaces the matching constraint.
  it("pins the gi size codes", () => {
    expect([...giSizes]).toEqual(["000", "00", "0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it("pins the belt size codes, which start at 0 and not 000", () => {
    expect([...beltSizes]).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it("gives every gi size a height and nothing else one", () => {
    expect(Object.keys(GI_HEIGHT_CM).sort()).toEqual([...giSizes].sort());
  });

  it("gives every belt size a length and nothing else one", () => {
    expect(Object.keys(BELT_LENGTH_CM).sort()).toEqual([...beltSizes].sort());
  });

  it("runs both charts in ascending order", () => {
    const heights = giSizes.map((s) => GI_HEIGHT_CM[s]);
    const lengths = beltSizes.map((s) => BELT_LENGTH_CM[s]);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  it("matches the club's charts at the ends", () => {
    expect(GI_HEIGHT_CM["000"]).toBe(110);
    expect(GI_HEIGHT_CM["7"]).toBe(200);
    expect(BELT_LENGTH_CM["0"]).toBe(180);
    expect(BELT_LENGTH_CM["7"]).toBe(320);
  });
});

describe("kit-sizes labels", () => {
  it("leads with the size code and keeps the measurement parenthetical", () => {
    expect(giSizeLabel("000")).toBe("000 (110 cm)");
    expect(giSizeLabel("1")).toBe("1 (140 cm)");
    expect(giSizeLabel("3")).toBe("3 (160 cm)");
    expect(giSizeLabel("7")).toBe("7 (200 cm)");
  });

  it("says 'belt' on every belt label, so the length is not read as a waist", () => {
    for (const size of beltSizes) {
      expect(beltSizeLabel(size)).toMatch(/^\d \(\d+ cm belt\)$/);
    }
    expect(beltSizeLabel("3")).toBe("3 (240 cm belt)");
  });

  it("formats a stored value, and returns null when there is nothing on file", () => {
    expect(formatGiSize("2")).toBe("2 (150 cm)");
    expect(formatBeltSize("2")).toBe("2 (220 cm belt)");
    expect(formatGiSize(null)).toBeNull();
    expect(formatBeltSize(undefined)).toBeNull();
    expect(formatGiSize("")).toBeNull();
    // A value the chart does not know about is not rendered as if it did.
    expect(formatGiSize("XL")).toBeNull();
    // "000" is a gi size but not a belt size, so it must not format as one.
    expect(formatBeltSize("000")).toBeNull();
  });
});

describe("beltSizeForGiSize", () => {
  it("hands out the matching belt code wherever the charts overlap", () => {
    for (const size of beltSizes) {
      expect(beltSizeForGiSize(size)).toBe(size);
    }
  });

  it("defaults the two kids' gi sizes to the shortest belt the club stocks", () => {
    expect(beltSizeForGiSize("000")).toBe("0");
    expect(beltSizeForGiSize("00")).toBe("0");
  });

  it("always returns a real belt size", () => {
    for (const size of giSizes) {
      expect(isBeltSize(beltSizeForGiSize(size))).toBe(true);
    }
  });
});

describe("kit-sizes guards", () => {
  it("recognises only its own codes", () => {
    expect(isGiSize("000")).toBe(true);
    expect(isGiSize("7")).toBe(true);
    expect(isGiSize("8")).toBe(false);
    expect(isGiSize("")).toBe(false);
    // The belt chart is the shorter of the two.
    expect(isBeltSize("000")).toBe(false);
    expect(isBeltSize("00")).toBe(false);
    expect(isBeltSize("0")).toBe(true);
  });
});
