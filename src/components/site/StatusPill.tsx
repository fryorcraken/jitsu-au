import { cn } from "@/lib/utils";

/**
 * The status badge every list and detail screen uses.
 *
 * It carries no colour of its own: the caller passes one from
 * `@/lib/status-colours`, which is the single place a status decides what it
 * looks like. Statuses are stored lowercase (`lead`, `pending`, `manager`), so
 * the capitalisation happens here rather than in each of the six screens that
 * render one.
 *
 * `preserveCase` is for the badges whose label is not an enum value but text
 * someone wrote: a plan name on the check-in board would otherwise come out as
 * "Unlimited Monthly".
 */
export function Pill({
  label,
  className,
  preserveCase = false,
}: {
  label: string;
  className: string;
  preserveCase?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        !preserveCase && "capitalize",
        className,
      )}
    >
      {label}
    </span>
  );
}
