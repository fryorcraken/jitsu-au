// "Resend" for one email about one record, shared by every manager screen that
// shows one (an invoice row, a waiver row, a person's email card).
//
// Resending is not irreversible, so per "The UX bar" it is not a confirm
// dialog. But it is outward-facing, so the button opens a small panel that says
// what will be sent and to which address BEFORE anything goes, with the Send
// in it. The panel asks the server, because only the server knows today's
// answer: the address on file now (the guardian's, for a child), whether the
// invoice has been paid since the page loaded, whether the email can be built
// at all. When it cannot, the panel says why and the Send stays disabled.
//
// The result stays in the panel with `role="status"`, never only in a toast: a
// manager between classes needs to still be looking at "Sent to ..." or "could
// not send, try again" when they glance back. The rules behind it (a new
// idempotency key per press, once a minute per email per record) are in
// `src/lib/email-resend.ts`.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Loading } from "@/components/site/Loading";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { RESEND_LABELS, type ResendKind, type ResendPreview } from "@/lib/email-resend";
import { getResendPreview, resendClubEmail, type ResendResult } from "@/lib/email-resend.functions";
import { describeLoadError } from "@/lib/load-error";

/**
 * Two attempts. A retry is safe: it carries the same click id, so it goes out
 * under the same idempotency key and the provider drops a duplicate.
 */
const RESEND_SUBMIT = { attempts: 2, timeoutMs: 20_000, slowAfterMs: 8_000 } as const;

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; preview: ResendPreview };

export function ResendEmailButton({
  kind,
  recordId,
  label = RESEND_LABELS[kind],
}: {
  kind: ResendKind;
  recordId: string;
  label?: string;
}) {
  const fetchPreview = useServerFn(getResendPreview);
  const resend = useServerFn(resendClubEmail);
  const send = useResilientSubmit<ResendResult>(RESEND_SUBMIT);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [result, setResult] = useState<ResendResult | null>(null);

  async function loadPreview() {
    setPreview({ status: "loading" });
    try {
      const p = await fetchPreview({ data: { kind, record_id: recordId } });
      setPreview({ status: "ready", preview: p });
    } catch (e) {
      setPreview({
        status: "failed",
        message: describeLoadError(e, "We could not check who this would go to."),
      });
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Asked afresh every time it opens: an invoice paid, or an address
    // corrected, since the last look changes what this would send.
    if (next) {
      setResult(null);
      void loadPreview();
    }
  }

  async function sendNow() {
    setResult(null);
    const outcome = await send.submit({
      run: (signal, submissionId) =>
        resend({
          signal,
          data: { kind, record_id: recordId, client_submission_id: submissionId },
        }),
    });
    if (outcome.ok) {
      setResult(outcome.value);
      // The next press is a new send, so it needs a new click id. A failure
      // keeps this one, so "Try again" retries the SAME send.
      send.reset();
    }
  }

  const ready = preview.status === "ready" ? preview.preview : null;
  const unavailable = ready && !ready.available ? ready : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Mail className="mr-1 h-3 w-3" aria-hidden="true" /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-sm">
        {preview.status === "loading" || preview.status === "idle" ? (
          <Loading label="Checking who this goes to..." />
        ) : preview.status === "failed" ? (
          <div role="alert" className="space-y-2">
            <p>{preview.message}</p>
            <Button size="sm" variant="outline" onClick={() => void loadPreview()}>
              Try again
            </Button>
          </div>
        ) : unavailable ? (
          // Why it cannot be sent, said where the Send would be, so a disabled
          // button never stands on its own with no explanation.
          <>
            <p className="text-muted-foreground">{unavailable.message}</p>
            <Button size="sm" disabled>
              <Send className="mr-1 h-3 w-3" aria-hidden="true" /> Send
            </Button>
          </>
        ) : ready && ready.available ? (
          <>
            <p>
              {ready.what} It goes to <strong className="break-all">{ready.to}</strong>
              {ready.toBelongsTo ? ` (${ready.toBelongsTo}'s address)` : ""}.
            </p>
            <Button size="sm" disabled={send.busy} onClick={() => void sendNow()}>
              <Send className="mr-1 h-3 w-3" aria-hidden="true" />
              {send.busy ? "Sending..." : result?.sent ? "Send again" : "Send"}
            </Button>
          </>
        ) : null}

        {result && (
          <p
            role="status"
            className={result.sent ? "font-medium text-foreground" : "text-muted-foreground"}
          >
            {result.sent ? `Sent to ${result.to}.` : result.message}
          </p>
        )}
        <SubmitStatus
          status={send.status}
          attempt={send.attempt}
          attempts={send.attempts}
          error={send.error}
          failureKind={send.failureKind}
          onRetry={() => void sendNow()}
        />
      </PopoverContent>
    </Popover>
  );
}
