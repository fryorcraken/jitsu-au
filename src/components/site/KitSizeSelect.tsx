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

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/** Shown under a gi picker. Sizes are cut for a height, so nobody is exactly one. */
export const GI_SIZE_HINT = "Round up or down depending on your body build.";

/**
 * Shown under a belt picker. The lead sentence exists because a bare "240 cm"
 * next to a size reads as a body measurement, and it is not one.
 */
export const BELT_SIZE_HINT =
  "The length is the belt itself, not your waist. If you are between sizes, take the next size up.";

type BaseProps = {
  id: string;
  disabled?: boolean;
  className?: string;
  /** Label for the "no size chosen" option. Both fields are always optional. */
  emptyLabel?: string;
};

export function GiSizeSelect({
  id,
  value,
  onChange,
  disabled,
  className,
  emptyLabel = "Not sure / prefer not to say",
}: BaseProps & {
  value: GiSize | "";
  onChange: (value: GiSize | "") => void;
}) {
  return (
    <select
      id={id}
      className={cn(selectClass, className)}
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
  emptyLabel = "Not sure / prefer not to say",
}: BaseProps & {
  value: BeltSize | "";
  onChange: (value: BeltSize | "") => void;
}) {
  return (
    <select
      id={id}
      className={cn(selectClass, className)}
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
