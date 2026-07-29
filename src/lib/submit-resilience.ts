// Getting a form submission through a bad connection.
//
// The failure this exists for is a waiver that never lands. Before it, every
// form did `setLoading(true); try { await serverFn() } catch { toast.error }`:
// no timeout (so a stalled request hung forever), no retry, and a raw
// `Failed to fetch` in a toast that auto-dismisses.
//
// ⚠️ The one thing to understand before changing anything here: **aborting a
// request client-side does not stop the server.** A timeout tells you the reply
// did not arrive, never that the work did not happen. Two consequences shape
// this whole module:
//
//   1. Every retry carries the SAME `client_submission_id`, so the server can
//      recognise a repeat and refuse to do the work twice
//      (20260729020000_submission_idempotency.sql).
//   2. After a failure we prefer to ASK ("did my waiver land?") over guessing.
//      That is the `confirm` hook below, and it is what turns "we don't know"
//      into an answer.
//
// Keep this file free of side effects and of any server-only or React
// dependency (no supabase clients, no process.env, no hooks) so it stays
// unit-testable, mirroring `validation.ts` and `auth-persistence.ts`. Anything
// that touches the DOM arrives as an injected default.

/** Why an attempt failed. Only `server` is a real refusal, and only it is final. */
export type SubmitFailureKind = "offline" | "timeout" | "network" | "server";

/** Progress reported while `submitWithRetry` works. Drives the on-screen copy. */
export type SubmitDriverState =
  | { phase: "submitting"; attempt: number }
  | { phase: "offline"; attempt: number }
  | { phase: "confirming"; attempt: number }
  | { phase: "retrying"; attempt: number; delayMs: number };

export type SubmitOutcome<T> =
  | { ok: true; value: T; attempts: number; confirmed: boolean }
  | { ok: false; kind: SubmitFailureKind; error: Error; attempts: number };

/**
 * Per-form tuning.
 *
 * The waiver gets far more room than the intake forms because its handler does
 * genuinely slow work in one request: resolve or create an auth user, insert the
 * row, render a PDF with pdf-lib, upload it, mint two signed URLs, then email
 * the member and every manager. 45s is "this server is not coming back",
 * not "this is taking a while".
 */
export const WAIVER_SUBMIT = { attempts: 5, timeoutMs: 45_000, slowAfterMs: 8_000 } as const;
export const INTAKE_SUBMIT = { attempts: 3, timeoutMs: 20_000, slowAfterMs: 8_000 } as const;

/** Backoff between attempts, in order. Index 0 is the wait after attempt 1. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;

/**
 * A uuid identifying one form fill, reused across every attempt of it.
 *
 * ⚠️ **This is a secret, not just a dedupe key.** `checkWaiverSubmission` answers
 * "did this submission land?" to anyone holding the id, and hands back a signed
 * link to the waiver PDF, which carries the signer's health declaration. The id
 * is the only thing guarding that, so it must come from a CSPRNG: 122 random
 * bits are unguessable, `Math.random()` is not.
 *
 * `crypto.randomUUID` is preferred but needs a secure context, which the live
 * site has and a plain-HTTP LAN dev server does not. `crypto.getRandomValues`
 * has no such requirement and is in every browser this app supports, so the
 * fallback is a real path rather than a weaker one. If neither exists we throw:
 * a caller that cannot mint a safe id must fail loudly, not quietly mint a
 * guessable one.
 */
export function newSubmissionId(): string {
  const c: Crypto | undefined = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (!c?.getRandomValues) {
    throw new Error("A secure random source is required to submit this form.");
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // RFC 4122 version 4 / variant 10xx.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Status codes worth another go: a gateway hiccup, a cold start, a rate limit. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** Pull an HTTP status off whatever error shape the transport threw. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const v of [e.status, e.statusCode, e.response?.status]) {
    if (typeof v === "number") return v;
  }
  return undefined;
}

/**
 * Decide whether a failed attempt is worth repeating.
 *
 * The distinction that matters is "the server said no" versus "we never heard
 * back". A server refusal (a missing acknowledgement, a signed-in email
 * mismatch) is a real answer: repeating it just shows the person the same error
 * five times. Everything else is a transport problem, where the work may well
 * have landed and the reply got lost.
 *
 * `online` is passed in rather than read from `navigator` so this stays pure.
 */
export function classifySubmitFailure(err: unknown, online: boolean = true): SubmitFailureKind {
  if (!online) return "offline";

  // AbortSignal.timeout() throws a TimeoutError; an explicit abort throws an
  // AbortError. Checked by name so it works in jsdom and on the server too,
  // where DOMException is not always the thrown type.
  const name =
    typeof err === "object" && err !== null ? (err as { name?: string }).name : undefined;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";

  const status = statusOf(err);
  if (typeof status === "number") return isTransientStatus(status) ? "network" : "server";

  // `fetch` rejects with a TypeError for every connection-level failure.
  if (err instanceof TypeError) return "network";

  const message = err instanceof Error ? err.message : String(err ?? "");
  if (
    /failed to fetch|load failed|networkerror|network ?request ?failed|connection (closed|reset|refused)|err_network|err_internet_disconnected|socket hang up/i.test(
      message,
    )
  ) {
    return "network";
  }

  return "server";
}

/** Everything except an outright refusal from the server is worth retrying. */
export function isRetryable(kind: SubmitFailureKind): boolean {
  return kind !== "server";
}

/**
 * How long to wait before attempt `attempt + 1`.
 *
 * Jittered by ±25% so a shared outage does not produce a synchronised stampede
 * when everyone's page retries on the same schedule. `rand` is injected so
 * tests can assert an exact number.
 */
export function retryDelayMs(attempt: number, rand: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1;
  const base = RETRY_DELAYS_MS[index];
  return Math.round(base * (1 + (rand() - 0.5) / 2));
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" && err ? err : "Something went wrong");
}

export type SubmitWithRetryOptions<T> = {
  /** Performs one attempt. Receives a signal that aborts at `timeoutMs`. */
  run: (signal: AbortSignal) => Promise<T>;
  /**
   * Asks the server whether this submission already landed. Resolves to the
   * result if it did, `null` if it did not. Optional, best-effort: a throw here
   * is swallowed and the retry loop simply continues.
   */
  confirm?: () => Promise<T | null>;
  attempts?: number;
  timeoutMs?: number;
  onState?: (state: SubmitDriverState) => void;
  /** Injected for tests: no real waiting, no real network, no real events. */
  sleep?: (ms: number) => Promise<void>;
  isOnline?: () => boolean;
  waitForOnline?: () => Promise<void>;
  createSignal?: (timeoutMs: number) => AbortSignal;
  rand?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultIsOnline = () =>
  typeof navigator === "undefined" || typeof navigator.onLine !== "boolean" || navigator.onLine;

const defaultWaitForOnline = () =>
  new Promise<void>((resolve) => {
    if (typeof window === "undefined") return resolve();
    const done = () => {
      window.removeEventListener("online", done);
      resolve();
    };
    window.addEventListener("online", done);
  });

/**
 * Run `run` until it succeeds, the server refuses, or the attempts run out.
 *
 * Being offline never consumes an attempt: it waits on the `online` event for as
 * long as the page is open, then sends. That is deliberate. Someone on a train
 * should come out of a tunnel to a submitted waiver, not to a form that gave up
 * three stations ago.
 */
export async function submitWithRetry<T>(
  options: SubmitWithRetryOptions<T>,
): Promise<SubmitOutcome<T>> {
  const {
    run,
    confirm,
    attempts = 3,
    timeoutMs = 20_000,
    onState,
    sleep = defaultSleep,
    isOnline = defaultIsOnline,
    waitForOnline = defaultWaitForOnline,
    createSignal = (ms: number) => AbortSignal.timeout(ms),
    rand = Math.random,
  } = options;

  let lastKind: SubmitFailureKind = "network";
  let lastError = new Error("Something went wrong");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!isOnline()) {
      onState?.({ phase: "offline", attempt });
      await waitForOnline();
    }

    onState?.({ phase: "submitting", attempt });
    try {
      const value = await run(createSignal(timeoutMs));
      return { ok: true, value, attempts: attempt, confirmed: false };
    } catch (err) {
      const kind = classifySubmitFailure(err, isOnline());
      lastKind = kind;
      lastError = toError(err);

      if (!isRetryable(kind)) return { ok: false, kind, error: lastError, attempts: attempt };

      // The reply is lost, which says nothing about whether the work happened.
      // Ask before sending anything again.
      if (confirm) {
        onState?.({ phase: "confirming", attempt });
        try {
          const landed = await confirm();
          if (landed !== null && landed !== undefined) {
            return { ok: true, value: landed, attempts: attempt, confirmed: true };
          }
        } catch {
          /* best-effort: an unanswerable check just means we retry */
        }
      }

      if (attempt >= attempts) break;

      const delayMs = retryDelayMs(attempt, rand);
      onState?.({ phase: "retrying", attempt, delayMs });
      await sleep(delayMs);
    }
  }

  return { ok: false, kind: lastKind, error: lastError, attempts };
}
