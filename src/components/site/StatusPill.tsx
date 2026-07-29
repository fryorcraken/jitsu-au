import { cn } from "@/lib/utils";

/**
 * The status badge every list and detail screen uses.
 *
 * It carries no colour of its own: the caller passes one from
 * `@/lib/status-colours`, which is the single place a status decides what it
 * looks like. Labels are stored lowercase (`lead`, `pending`, `manager`), so
 * the capitalisation happens here rather than in each of the five screens that
 * render one.
 */
export function Pill({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        className,
      )}
    >
      {label}
    </span>
  );
}
