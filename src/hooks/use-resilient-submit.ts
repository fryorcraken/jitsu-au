import { useCallback, useEffect, useRef, useState } from "react";
import {
  newSubmissionId,
  submitWithRetry,
  type SubmitFailureKind,
  type SubmitOutcome,
} from "@/lib/submit-resilience";

/**
 * What the page is doing right now, for the line under the submit button.
 *
 * `slow` is not a failure. It exists because the honest answer to "why is
 * nothing happening" is usually "your connection is bad and we are still
 * waiting", and saying so is what stops people closing the tab.
 */
export type ResilientSubmitStatus =
  | "idle"
  | "submitting"
  | "slow"
  | "confirming"
  | "retrying"
  | "offline"
  | "failed"
  | "succeeded";

export type ResilientSubmitConfig = {
  attempts: number;
  timeoutMs: number;
  slowAfterMs: number;
};

export type RunSubmit<T> = {
  run: (signal: AbortSignal, submissionId: string) => Promise<T>;
  /** Optional "did this already land?" check. See submit-resilience.ts. */
  confirm?: (submissionId: string) => Promise<T | null>;
};

/**
 * React wrapper around `submitWithRetry`.
 *
 * Owns the two things the driver deliberately does not: the submission id that
 * has to stay stable across every attempt of one form fill, and the React state
 * the page renders from. All the retry logic itself lives in the pure module, so
 * it can be tested without a DOM.
 */
export function useResilientSubmit<T>(config: ResilientSubmitConfig) {
  const [submissionId, setSubmissionId] = useState(newSubmissionId);
  const [status, setStatus] = useState<ResilientSubmitStatus>("idle");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [failureKind, setFailureKind] = useState<SubmitFailureKind | null>(null);

  const mounted = useRef(true);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const clearSlowTimer = useCallback(() => {
    if (slowTimer.current !== null) {
      clearTimeout(slowTimer.current);
      slowTimer.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (slowTimer.current !== null) clearTimeout(slowTimer.current);
    };
  }, []);

  /**
   * Reuse an id from elsewhere, e.g. one restored from a saved draft.
   *
   * This is what lets a reload mid-submit ask "did that land?" rather than send
   * a second copy of the same thing.
   */
  const adoptSubmissionId = useCallback((id: string) => setSubmissionId(id), []);

  /** Start a fresh form fill: a new id, so it is genuinely a new submission. */
  const reset = useCallback(() => {
    clearSlowTimer();
    setSubmissionId(newSubmissionId());
    setStatus("idle");
    setAttempt(0);
    setError(null);
    setFailureKind(null);
  }, [clearSlowTimer]);

  const submit = useCallback(
    async ({ run, confirm }: RunSubmit<T>): Promise<SubmitOutcome<T>> => {
      // Guard the double-tap: `disabled` on the button is not enough on a phone,
      // where a second tap can land before React has re-rendered.
      if (inFlight.current)
        return { ok: false, kind: "server", error: new Error("Already sending."), attempts: 0 };
      inFlight.current = true;

      setError(null);
      setFailureKind(null);
      setAttempt(1);

      const outcome = await submitWithRetry<T>({
        attempts: config.attempts,
        timeoutMs: config.timeoutMs,
        run: (signal) => run(signal, submissionId),
        confirm: confirm ? () => confirm(submissionId) : undefined,
        onState: (state) => {
          if (!mounted.current) return;
          clearSlowTimer();
          setAttempt(state.attempt);
          if (state.phase === "submitting") {
            setStatus("submitting");
            // Only a hint, and only while an attempt is actually open.
            slowTimer.current = setTimeout(() => {
              if (mounted.current) setStatus("slow");
            }, config.slowAfterMs);
          } else {
            setStatus(state.phase);
          }
        },
      });

      inFlight.current = false;
      if (mounted.current) {
        clearSlowTimer();
        if (outcome.ok) {
          setStatus("succeeded");
        } else {
          setStatus("failed");
          setError(outcome.error);
          setFailureKind(outcome.kind);
        }
      }
      return outcome;
    },
    [clearSlowTimer, config.attempts, config.slowAfterMs, config.timeoutMs, submissionId],
  );

  return {
    submissionId,
    adoptSubmissionId,
    status,
    attempt,
    attempts: config.attempts,
    error,
    failureKind,
    /** True whenever something is in flight, for disabling the submit button. */
    busy:
      status === "submitting" ||
      status === "slow" ||
      status === "confirming" ||
      status === "retrying" ||
      status === "offline",
    submit,
    reset,
  };
}
