// The club's gi and belt size charts.
//
// This module is the single home for both code sets, in the same spirit as
// `kb.ts`: one exported const array feeds the Zod enums in `validation.ts`, the
// pickers on `/account`, `/waiver` and the manager screens, and the labels the
// manager list renders. Keeping them here is what stops the vocabulary drifting
// into several disagreeing lists.
//
// Pure: no side effects, no server imports.
//
// ⚠️ The same two code sets are also written into CHECK constraints on
// `public.profiles` (`profiles_gi_size_check`, `profiles_belt_size_check`, added
// by `supabase/migrations/20260806000000_profile_kit_sizes.sql`). Nothing in the
// test suite can see a CHECK constraint, so widening either array here without a
// migration replacing the matching constraint turns into a PostgREST 400 at
// runtime. `kit-sizes.test.ts` pins both literals for that reason.

/**
 * Gi sizes, smallest first. A gi size is a standard size code, and each code
 * corresponds to a wearer height (see `GI_HEIGHT_CM`).
 */
export const giSizes = ["000", "00", "0", "1", "2", "3", "4", "5", "6", "7"] as const;
export type GiSize = (typeof giSizes)[number];

/**
 * Belt sizes, smallest first. The club's belt chart starts at `0`, so it is a
 * SHORTER list than the gi chart: there is no `000` or `00` belt.
 */
export const beltSizes = ["0", "1", "2", "3", "4", "5", "6", "7"] as const;
export type BeltSize = (typeof beltSizes)[number];

/** The wearer height, in centimetres, each gi size is cut for. */
export const GI_HEIGHT_CM: Record<GiSize, number> = {
  "000": 110,
  "00": 120,
  "0": 130,
  "1": 140,
  "2": 150,
  "3": 160,
  "4": 170,
  "5": 180,
  "6": 190,
  "7": 200,
};

/**
 * The length of the belt itself, in centimetres. This is the piece of fabric,
 * not a waist measurement, which is why every label that shows it says "belt".
 */
export const BELT_LENGTH_CM: Record<BeltSize, number> = {
  "0": 180,
  "1": 200,
  "2": 220,
  "3": 240,
  "4": 260,
  "5": 280,
  "6": 300,
  "7": 320,
};

/**
 * A gi size as it is shown to a person: the size code first, with the height as
 * a parenthetical aid, e.g. `1 (140 cm)`. The code leads and is never replaced
 * by the height, so somebody who already knows their size can pick it straight
 * off and somebody who does not can find it from their height.
 */
export function giSizeLabel(size: GiSize): string {
  return `${size} (${GI_HEIGHT_CM[size]} cm)`;
}

/**
 * A belt size as it is shown to a person, e.g. `1 (200 cm belt)`. The trailing
 * "belt" is load-bearing: without it the number reads as a body measurement.
 */
export function beltSizeLabel(size: BeltSize): string {
  return `${size} (${BELT_LENGTH_CM[size]} cm belt)`;
}

/**
 * The belt the club would hand out with a given gi size: the same code, except
 * for the two kids' gi sizes below the belt chart's smallest entry, which get
 * the shortest belt stocked. Used only to seed a belt size for somebody who has
 * none; a member or manager can change it afterwards.
 */
export function beltSizeForGiSize(size: GiSize): BeltSize {
  return (beltSizes as readonly string[]).includes(size) ? (size as BeltSize) : beltSizes[0];
}

/** Whether an arbitrary string is a gi size code. */
export function isGiSize(value: string): value is GiSize {
  return (giSizes as readonly string[]).includes(value);
}

/** Whether an arbitrary string is a belt size code. */
export function isBeltSize(value: string): value is BeltSize {
  return (beltSizes as readonly string[]).includes(value);
}

/** A stored gi size rendered for display, or `null` when there is none on file. */
export function formatGiSize(value: string | null | undefined): string | null {
  return value && isGiSize(value) ? giSizeLabel(value) : null;
}

/** A stored belt size rendered for display, or `null` when there is none on file. */
export function formatBeltSize(value: string | null | undefined): string | null {
  return value && isBeltSize(value) ? beltSizeLabel(value) : null;
}
