import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import SignaturePadLib from "signature_pad";
import { Button } from "@/components/ui/button";
import { Eraser } from "lucide-react";

export type SignaturePadHandle = {
  isEmpty: () => boolean;
  toDataURL: () => string;
  clear: () => void;
};

type Props = {
  onChange?: (dataUrl: string) => void;
  ariaLabel?: string;
  /**
   * A signature to start from, e.g. one restored from a saved draft. Applied
   * once, on mount: after that the pad owns its own content and re-applying
   * would fight the person drawing on it.
   */
  initialDataUrl?: string;
};

export const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad(
  { onChange, ariaLabel = "Signature pad", initialDataUrl }: Props,
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);
  // Read inside the mount effect rather than listed as a dependency: this is a
  // starting value, not a binding, and re-running on a changed prop would wipe
  // whatever has been drawn since.
  const initialRef = useRef(initialDataUrl);
  /**
   * The last signature we know is real, kept out of the canvas on purpose.
   *
   * `fromDataURL` sets `_isEmpty = false` synchronously but only paints in
   * `image.onload`, so for one macrotask the pad reports "not empty" over a
   * blank canvas. Re-reading `toDataURL()` inside a resize can therefore capture
   * that blank and then write it back as the signature. Browsers fire resize in
   * bursts (keyboard animation, URL-bar collapse, rotation), so this is not a
   * narrow window: it is the exact bug the resize handler was fixed to stop,
   * coming back through the fix itself.
   */
  const lastGoodRef = useRef(initialDataUrl ?? "");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);

    /**
     * Resize the backing store, preserving what is drawn.
     *
     * Changing canvas.width/height blanks the canvas, so the signature has to be
     * captured and re-applied around it. This used to just call `pad.clear()`,
     * which meant that on a phone, opening the on-screen keyboard for the next
     * field erased the signature the person had just drawn. They usually did not
     * notice until the form refused to submit.
     *
     * The value comes from `lastGoodRef`, never from the canvas: see the ref's
     * comment for why reading the canvas here can capture a blank.
     */
    const resize = () => {
      const pad = padRef.current;
      const previous = lastGoodRef.current;
      const rect = canvas.getBoundingClientRect();
      // A hidden pad (the inactive tab of the draw/type switch) measures 0x0.
      // Resizing to that would throw away the signature for good, so skip it and
      // let the next visible resize do the work.
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      const ctx = canvas.getContext("2d");
      ctx?.scale(ratio, ratio);
      pad?.clear();
      if (previous) void pad?.fromDataURL(previous, { width: rect.width, height: rect.height });
    };

    const pad = new SignaturePadLib(canvas, {
      backgroundColor: "rgba(255,255,255,0)",
      penColor: "#0f172a",
      minWidth: 0.8,
      maxWidth: 2.2,
    });
    padRef.current = pad;
    resize();

    const restored = initialRef.current;
    if (restored) {
      const rect = canvas.getBoundingClientRect();
      void pad.fromDataURL(restored, { width: rect.width, height: rect.height });
    }

    // A finished stroke is the only moment the canvas is definitively settled,
    // so it is the only moment we trust it as the new known-good value.
    const emit = () => {
      const next = pad.isEmpty() ? "" : pad.toDataURL("image/png");
      lastGoodRef.current = next;
      onChange?.(next);
    };
    pad.addEventListener("endStroke", emit);
    window.addEventListener("resize", resize);
    return () => {
      pad.removeEventListener("endStroke", emit);
      window.removeEventListener("resize", resize);
      pad.off();
    };
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      isEmpty: () => lastGoodRef.current === "",
      toDataURL: () => lastGoodRef.current,
      clear: () => {
        padRef.current?.clear();
        lastGoodRef.current = "";
        onChange?.("");
      },
    }),
    [onChange],
  );

  return (
    <div className="space-y-2">
      <div className="relative rounded-md border bg-background">
        <canvas
          ref={canvasRef}
          aria-label={ariaLabel}
          className="block h-40 w-full touch-none rounded-md"
        />
        <span className="pointer-events-none absolute bottom-1 left-2 select-none text-[10px] uppercase tracking-wider text-muted-foreground/70">
          Sign here
        </span>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            padRef.current?.clear();
            lastGoodRef.current = "";
            onChange?.("");
          }}
        >
          <Eraser className="mr-1.5 h-3.5 w-3.5" /> Clear
        </Button>
      </div>
    </div>
  );
});
