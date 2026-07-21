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
};

export const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad(
  { onChange, ariaLabel = "Signature pad" },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      const ctx = canvas.getContext("2d");
      ctx?.scale(ratio, ratio);
      padRef.current?.clear();
    };
    const pad = new SignaturePadLib(canvas, {
      backgroundColor: "rgba(255,255,255,0)",
      penColor: "#0f172a",
      minWidth: 0.8,
      maxWidth: 2.2,
    });
    padRef.current = pad;
    resize();
    const emit = () => {
      if (pad.isEmpty()) onChange?.("");
      else onChange?.(pad.toDataURL("image/png"));
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
      isEmpty: () => padRef.current?.isEmpty() ?? true,
      toDataURL: () =>
        padRef.current && !padRef.current.isEmpty() ? padRef.current.toDataURL("image/png") : "",
      clear: () => {
        padRef.current?.clear();
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
            onChange?.("");
          }}
        >
          <Eraser className="mr-1.5 h-3.5 w-3.5" /> Clear
        </Button>
      </div>
    </div>
  );
});
