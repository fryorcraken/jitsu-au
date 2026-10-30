import { cn } from "@/lib/utils";
import {
  type BeltSize,
  type GiSize,
  beltSizeLabel,
  beltSizes,
  giSizeLabel,
  giSizes,
} from "@/lib/kit-sizes";

/**
 * The gi and belt pickers, in one place so the three screens that offer them
 * (`/account`, `/waiver`, and a manager's view of somebody's record) cannot
 * drift apart on labels or on the wording that explains the numbers.
 *
 * A native `<select>` rather than the Radix primitive in `components/ui/select`,
 * for two reasons. Both fields are optional, and Radix's `<SelectItem>` refuses
 * an empty value, so "not set" would need a sentinel that every caller has to
 * remember to map back. And `/waiver` is a public, server-rendered page in the
 * PR screenshot sweep, which is the last place to introduce a portal-based
 * primitive nothing else on a public page uses. A native select also shows the
 * chosen option's full text, which is the whole point below.
 *
 * Every option leads with the size CODE and carries the measurement as a
 * parenthetical aid: somebody who knows their size picks it straight off,
 * somebody who does not finds it from the measurement, and the code stays
 * visible once chosen instead of being replaced by a number of centimetres.
 */

/** The look of every native `<select>` on a form: the state picker uses it too. */
export const nativeSelectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/**
 * Shown under a gi picker. The height each size is cut for is already in the
 * option label (`giSizeLabel`), so this only says what to do with it: nobody is
 * exactly one height. No screen adds its own sentence explaining the number;
 * that is the label's job, so it reads the same everywhere.
 */
export const GI_SIZE_HINT = "Round up or down depending on your body build.";

/**
 * Shown under a belt picker. The lead sentence exists because a bare "240 cm"
 * next to a size reads as a body measurement, and it is not one.
 */
export const BELT_SIZE_HINT =
  "The length is the belt itself, not your waist. If you are between sizes, take the next size up.";

/** The empty option's default label: see `emptyLabel`. */
export const EMPTY_SIZE_LABEL = "Not on file";

/**
 * `/waiver`'s empty gi option. Leaving it empty keeps whatever is on file, and
 * it is what somebody who does not know their size should pick.
 */
export const WAIVER_GI_EMPTY_LABEL = "Not sure, skip this";

type BaseProps = {
  id: string;
  disabled?: boolean;
  className?: string;
  /**
   * Label for the empty option. Both fields are always optional. The default
   * is right wherever an empty pick means "no size on file" and saving it
   * clears the size (`/account`, a manager's view of a record). `/waiver`
   * passes its own, because there an empty pick keeps whatever is on file
   * (docs/waivers.md, rule 3), so a label claiming there is none would be
   * untrue for a returning signer whose size was not prefilled.
   */
  emptyLabel?: string;
};

export function GiSizeSelect({
  id,
  value,
  onChange,
  disabled,
  className,
  emptyLabel = EMPTY_SIZE_LABEL,
}: BaseProps & {
  value: GiSize | "";
  onChange: (value: GiSize | "") => void;
}) {
  return (
    <select
      id={id}
      className={cn(nativeSelectClass, className)}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as GiSize | "")}
    >
      <option value="">{emptyLabel}</option>
      {giSizes.map((size) => (
        <option key={size} value={size}>
          {giSizeLabel(size)}
        </option>
      ))}
    </select>
  );
}

export function BeltSizeSelect({
  id,
  value,
  onChange,
  disabled,
  className,
  emptyLabel = EMPTY_SIZE_LABEL,
}: BaseProps & {
  value: BeltSize | "";
  onChange: (value: BeltSize | "") => void;
}) {
  return (
    <select
      id={id}
      className={cn(nativeSelectClass, className)}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as BeltSize | "")}
    >
      <option value="">{emptyLabel}</option>
      {beltSizes.map((size) => (
        <option key={size} value={size}>
          {beltSizeLabel(size)}
        </option>
      ))}
    </select>
  );
}
