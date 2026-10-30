import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { nativeSelectClass } from "@/components/site/KitSizeSelect";
import {
  AU_ADDRESS_LABELS,
  AU_ADDRESS_LIMITS,
  AU_STATES,
  AU_STATE_NAMES,
  auAddressFieldId,
  auAddressProblems,
  postcodeStateNote,
  type AuAddressDraft,
  type AuAddressPart,
  type AuState,
} from "@/lib/au-address";

/**
 * An Australian address as four fields: street, suburb, state and postcode.
 *
 * One component for every screen that asks for an address (`/waiver`, the
 * account page, a manager filing a paper waiver), so the labels, the order and
 * the browser's autofill hints cannot drift apart. The rules a filled-in
 * address has to meet live in `@/lib/au-address`; this only lays the fields
 * out and reports what was typed.
 *
 * The state is a native `<select>`, styled and chosen for the reasons
 * `KitSizeSelect` gives: it
 * has to be able to stand empty, and `/waiver` is a public server-rendered page
 * where a portal-based picker would be the only one.
 *
 * The autofill hints are most of the point on a phone: they let somebody fill
 * all four from their saved address in one tap. `section` keeps a second
 * address on the same form (a parent's) from being filled with the first.
 */

const AUTOCOMPLETE: Record<AuAddressPart, string> = {
  street: "address-line1",
  suburb: "address-level2",
  state: "address-level1",
  postcode: "postal-code",
};

export function AddressFields({
  idPrefix,
  value,
  onChange,
  disabled,
  section,
  previousLine,
  showProblems,
  fieldProps,
  fieldMessage,
}: {
  /** Prefix for each input's id, e.g. `address` gives `address_street`. */
  idPrefix: string;
  value: AuAddressDraft;
  onChange: (next: AuAddressDraft) => void;
  disabled?: boolean;
  /** An autofill section name, for a form holding more than one address. */
  section?: string;
  /**
   * An address the club holds only as one line, which could not be read as
   * parts. Shown above the fields so nobody has to remember what they told us
   * last time, and so it is plain why the boxes are empty.
   */
  previousLine?: string | null;
  /**
   * Flag every part that is missing or wrong, with a line under it saying
   * what it wants. For a form with no checking of its own (the account page,
   * a manager filing a paper waiver), turned on once somebody presses Save.
   * A form that runs its own checklist (`/waiver`) passes `fieldProps` and
   * `fieldMessage` instead, so the boxes speak in the same voice as the rest.
   */
  showProblems?: boolean;
  /** Extra props for a part's control, by its id: how a form flags a field. */
  fieldProps?: (id: string) => { className?: string } & Record<string, unknown>;
  /** The line under a part, by its id, when the form has something to say. */
  fieldMessage?: (id: string) => ReactNode;
}) {
  const problems = showProblems ? auAddressProblems(value) : [];
  const problemFor = (fieldId: string) => problems.find((p) => id(p.part) === fieldId);
  const flagProps = (fieldId: string) =>
    problemFor(fieldId)
      ? {
          "aria-invalid": true,
          "aria-describedby": `${fieldId}_needed`,
          className: "border-destructive focus-visible:ring-destructive",
        }
      : {};
  const flagMessage = (fieldId: string) => {
    const problem = problemFor(fieldId);
    if (!problem) return null;
    return (
      <p id={`${fieldId}_needed`} className="mt-1.5 text-xs font-medium text-destructive">
        {problem.hint ? `${problem.hint}.` : "Please fill this in."}
      </p>
    );
  };
  const propsFor = fieldProps ?? flagProps;
  const messageFor = fieldMessage ?? flagMessage;
  const id = (part: AuAddressPart) => auAddressFieldId(idPrefix, part);
  const auto = (part: AuAddressPart) =>
    section ? `section-${section} ${AUTOCOMPLETE[part]}` : AUTOCOMPLETE[part];
  const set = (part: AuAddressPart, next: string) => onChange({ ...value, [part]: next });
  const props = (part: AuAddressPart) => {
    const { className, ...rest } = propsFor(id(part));
    return { className: cn("mt-1.5", className), ...rest };
  };

  const { className: stateClass, ...stateRest } = props("state");
  // Not shown while the postcode box is itself flagged as wrong: one thing to
  // fix at a time, and the error is the one that stops the form.
  const postcodeFlagged = Boolean(messageFor(id("postcode")));
  const note = postcodeFlagged ? null : postcodeStateNote(value);

  return (
    <div className="space-y-3">
      {previousLine && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          We have this address as &ldquo;{previousLine}&rdquo;. Please enter it in the boxes below
          so we have the suburb and postcode separately.
        </p>
      )}
      <div>
        <Label htmlFor={id("street")}>{AU_ADDRESS_LABELS.street}</Label>
        <Input
          id={id("street")}
          autoComplete={auto("street")}
          maxLength={AU_ADDRESS_LIMITS.street}
          value={value.street}
          disabled={disabled}
          onChange={(e) => set("street", e.target.value)}
          placeholder="e.g. Unit 3, 12 Smith St"
          {...props("street")}
        />
        {messageFor(id("street"))}
      </div>
      <div>
        <Label htmlFor={id("suburb")}>{AU_ADDRESS_LABELS.suburb}</Label>
        <Input
          id={id("suburb")}
          autoComplete={auto("suburb")}
          maxLength={AU_ADDRESS_LIMITS.suburb}
          value={value.suburb}
          disabled={disabled}
          onChange={(e) => set("suburb", e.target.value)}
          {...props("suburb")}
        />
        {messageFor(id("suburb"))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor={id("state")}>{AU_ADDRESS_LABELS.state}</Label>
          <select
            id={id("state")}
            autoComplete={auto("state")}
            value={value.state}
            disabled={disabled}
            onChange={(e) => set("state", e.target.value as AuState | "")}
            {...stateRest}
            className={cn(nativeSelectClass, stateClass)}
          >
            <option value="">Choose</option>
            {AU_STATES.map((state) => (
              <option key={state} value={state} title={AU_STATE_NAMES[state]}>
                {state}
              </option>
            ))}
          </select>
          {messageFor(id("state"))}
        </div>
        <div>
          <Label htmlFor={id("postcode")}>{AU_ADDRESS_LABELS.postcode}</Label>
          <Input
            id={id("postcode")}
            autoComplete={auto("postcode")}
            inputMode="numeric"
            maxLength={4}
            value={value.postcode}
            disabled={disabled}
            onChange={(e) => set("postcode", e.target.value)}
            {...props("postcode")}
          />
          {messageFor(id("postcode"))}
        </div>
      </div>
      {/* Under both boxes rather than one, because it is about the pair: the
          slip it catches is usually the state, not the postcode. A note, not
          an error: it never stops anybody sending (see postcodeStateNote).
          Polite live region so a screen reader hears it once, as it appears. */}
      <p
        id={`${idPrefix}_postcode_note`}
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground empty:hidden"
      >
        {note}
      </p>
    </div>
  );
}
