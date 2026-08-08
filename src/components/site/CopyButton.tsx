import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface CopyButtonProps {
  /** The exact string put on the clipboard. */
  text: string;
  /** Button label, e.g. "Copy reference". Also the accessible name. */
  label: string;
  className?: string;
}

/**
 * Copy one string to the clipboard, with a transient "copied" tick.
 *
 * Clipboard access can be refused outright (older browsers, no secure context,
 * a permission prompt the person dismissed), so the failure path matters: every
 * caller keeps the value visible on screen, and the toast tells the person to
 * select it by hand rather than leaving a button that silently does nothing.
 */
export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy. Select and copy manually.");
        }
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {label}
    </Button>
  );
}

export default CopyButton;
