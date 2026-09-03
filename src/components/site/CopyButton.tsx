import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface CopyButtonProps {
  /** The exact string put on the clipboard. */
  text: string;
  /** Button label, e.g. "Copy reference". Also the accessible name by default. */
  label: string;
  /**
   * Accessible name, when the visible label is not enough on its own. A table
   * of rows each with a "Copy link" button reads as a dozen identical buttons
   * to a screen reader; this says which row it belongs to.
   */
  ariaLabel?: string;
  className?: string;
}

/**
 * Copy one string to the clipboard, with a transient "copied" tick.
 *
 * Clipboard access can be refused outright (older browsers, no secure context,
 * a permission prompt the person dismissed), so the failure path matters: the
 * failure carries the value itself and stays on screen until dismissed, so the
 * person can always select it by hand. It used to say "select it manually" and
 * rely on every caller happening to print the value next to the button, which
 * left anyone whose caller did not (a table row copying a URL it never shows)
 * with nothing to select.
 */
export function CopyButton({ text, label, ariaLabel, className }: CopyButtonProps) {
  // A counter, not a boolean, and the timer belongs to an effect rather than to
  // the click. Both of those are load-bearing.
  //
  // The timer has to be cancellable. Left running it outlives the component: it
  // fires against a React tree that is gone, and under the test runner it lands
  // after jsdom has been torn down, where React reads `window.event` and throws
  // `ReferenceError` OUTSIDE any test body. That failure belongs to no test, so
  // the suite reports every test passing and still exits non-zero — a red CI run
  // nobody can trace to a change. (The global `setTimeout` here is Node's, so
  // jsdom's own teardown does not cancel it for us.)
  //
  // Starting it from the click cannot fix that on its own: the click is async,
  // so an unmount while `writeText` is still in flight runs the cleanup BEFORE
  // the timer exists, and the continuation then schedules one nothing will ever
  // clear. An effect only ever runs on a mounted tree, so the timer and its
  // `clearTimeout` are created and destroyed together.
  //
  // The counter is what makes a second click restart the full 1.5s: a boolean
  // would already be `true`, the effect would not re-run, and the first click's
  // timer would cut the new tick short.
  const [copiedTick, setCopiedTick] = useState(0);
  const copied = copiedTick > 0;
  useEffect(() => {
    if (!copiedTick) return;
    const id = setTimeout(() => setCopiedTick(0), 1500);
    return () => clearTimeout(id);
  }, [copiedTick]);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={ariaLabel}
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopiedTick((tick) => tick + 1);
        } catch {
          toast.error("Couldn't copy that automatically.", {
            description: `Select this and copy it by hand: ${text}`,
            duration: Infinity,
            closeButton: true,
          });
        }
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {label}
    </Button>
  );
}

export default CopyButton;
