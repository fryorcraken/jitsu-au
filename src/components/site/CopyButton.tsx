import { useEffect, useRef, useState } from "react";
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
  const [copied, setCopied] = useState(false);
  // The tick's timer has to be cancellable. Left running it outlives the
  // component: it fires against a React tree that is gone, and in the test
  // environment it lands after jsdom has been torn down, where touching
  // `window` throws `ReferenceError` OUTSIDE any test body. That failure is
  // attributed to no test, so the suite reports every test passing and still
  // exits non-zero, which reads as a random red CI run on an unrelated change.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
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
          setCopied(true);
          // Cleared first, so a second click restarts the 1.5s rather than
          // letting the first click's timer cut the new tick short.
          if (resetTimer.current) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => setCopied(false), 1500);
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
