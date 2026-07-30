import { afterEach, describe, it, expect, vi } from "vitest";
import {
  RETRY_DELAYS_MS,
  classifySubmitFailure,
  isRetryable,
  newSubmissionId,
  retryDelayMs,
  submitWithRetry,
} from "./submit-resilience";

/** An abort signal stub: these tests never actually time anything out. */
const noSignal = () => new AbortController().signal;

/** Injected sleep that records what it was asked to wait, and waits nothing. */
function recordingSleep() {
  const waited: number[] = [];
  return {
    waited,
    sleep: async (ms: number) => {
      waited.push(ms);
    },
  };
}

function timeoutError() {
  const err = new Error("The operation timed out.");
  err.name = "TimeoutError";
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifySubmitFailure", () => {
  it("reports offline before anything else", () => {
    // Offline is about the device, not the error, so it wins even over an error
    // that would otherwise read as a server refusal.
    expect(classifySubmitFailure(new Error("Please accept: the terms"), false)).toBe("offline");
  });

  it("treats an aborted or timed-out request as a timeout", () => {
    expect(classifySubmitFailure(timeoutError())).toBe("timeout");
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(classifySubmitFailure(aborted)).toBe("timeout");
  });

  it("treats a fetch-level TypeError as a network failure", () => {
    expect(classifySubmitFailure(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("recognises the browsers' various connection-failure wordings", () => {
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "Network request failed",
      "socket hang up",
      "connection reset",
    ]) {
      expect(classifySubmitFailure(new Error(message))).toBe("network");
    }
  });

  it("retries a transient status but not a refusal, when a status is attached", () => {
    // Belt-and-braces: TanStack's server-function client attaches no status, so
    // this branch is for other transports. The HTML-body case below is the one
    // that actually fires in this app.
    expect(classifySubmitFailure({ status: 502, message: "Bad Gateway" })).toBe("network");
    expect(classifySubmitFailure({ status: 504 })).toBe("network");
    expect(classifySubmitFailure({ status: 429 })).toBe("network");
    expect(classifySubmitFailure({ status: 400 })).toBe("server");
    expect(classifySubmitFailure({ response: { status: 403 } })).toBe("server");
  });

  it("retries an HTTP error page delivered as an Error message", () => {
    // The real shape of a gateway failure here. TanStack's client does
    // `throw new Error(await response.text())` for a response it cannot parse,
    // so a Cloudflare 502 page or this app's own renderErrorPage() HTML arrives
    // as a plain Error carrying the whole body and NO status. Classified as a
    // refusal it would skip every retry on exactly the failures this module
    // exists for, and print an HTML document at someone mid-way through signing.
    const cloudflare = new Error(
      "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>...</body></html>",
    );
    expect(classifySubmitFailure(cloudflare)).toBe("network");
    expect(classifySubmitFailure(new Error("<html><body>Service Unavailable</body></html>"))).toBe(
      "network",
    );
    // An overlong body with no markup is still not something a human wrote.
    expect(classifySubmitFailure(new Error("x".repeat(500)))).toBe("network");
  });

  it("still treats a one-sentence message as a refusal", () => {
    expect(classifySubmitFailure(new Error("Please accept: the terms"))).toBe("server");
    expect(
      classifySubmitFailure(
        new Error("You're signed in as a@b.com, so the waiver must use that email."),
      ),
    ).toBe("server");
  });

  it("treats a message thrown by the handler as a final server refusal", () => {
    // This is the case a retry must never touch: repeating it just shows the
    // person the same validation error five times.
    expect(classifySubmitFailure(new Error("Please accept: the terms"))).toBe("server");
    expect(isRetryable("server")).toBe(false);
    for (const kind of ["offline", "timeout", "network"] as const) {
      expect(isRetryable(kind)).toBe(true);
    }
  });
});

describe("retryDelayMs", () => {
  it("follows the backoff schedule with no jitter at the midpoint", () => {
    const noJitter = () => 0.5;
    expect(RETRY_DELAYS_MS.map((_, i) => retryDelayMs(i + 1, noJitter))).toEqual([
      ...RETRY_DELAYS_MS,
    ]);
  });

  it("clamps past the end of the schedule instead of returning undefined", () => {
    expect(retryDelayMs(99, () => 0.5)).toBe(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    expect(retryDelayMs(0, () => 0.5)).toBe(RETRY_DELAYS_MS[0]);
  });

  it("jitters within ±25%", () => {
    expect(retryDelayMs(1, () => 0)).toBe(750);
    expect(retryDelayMs(1, () => 1)).toBe(1250);
  });
});

describe("newSubmissionId", () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("mints distinct v4 uuids", () => {
    const a = newSubmissionId();
    const b = newSubmissionId();
    expect(a).toMatch(uuidV4);
    expect(a).not.toBe(b);
  });

  it("falls back to getRandomValues when randomUUID needs a secure context", () => {
    // randomUUID is unavailable over plain HTTP (a LAN dev server); getRandomValues
    // is not, so this branch is a real path and must still produce a valid v4.
    vi.spyOn(globalThis, "crypto", "get").mockReturnValue({
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = i * 7;
        return a;
      },
    } as unknown as Crypto);

    expect(newSubmissionId()).toMatch(uuidV4);
  });

  it("throws rather than minting a guessable id with no CSPRNG", () => {
    // This id is a secret: checkWaiverSubmission hands anyone holding it a signed
    // link to a waiver PDF, health declaration included. A Math.random() fallback
    // would silently downgrade that to something predictable, so failing loudly
    // is the only safe option left.
    vi.spyOn(globalThis, "crypto", "get").mockReturnValue(undefined as unknown as Crypto);

    expect(() => newSubmissionId()).toThrow(/secure random source/i);
  });
});

describe("submitWithRetry", () => {
  const base = {
    createSignal: noSignal,
    isOnline: () => true,
    rand: () => 0.5,
  };

  it("returns the value on a first-attempt success without sleeping", async () => {
    const { waited, sleep } = recordingSleep();
    const result = await submitWithRetry({
      ...base,
      sleep,
      run: async () => "saved",
    });
    expect(result).toEqual({ ok: true, value: "saved", attempts: 1, confirmed: false });
    expect(waited).toEqual([]);
  });

  it("retries a network failure and succeeds on a later attempt", async () => {
    const { waited, sleep } = recordingSleep();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("saved");

    const result = await submitWithRetry({ ...base, sleep, attempts: 5, run });

    expect(result.ok && result.value).toBe("saved");
    expect(result.ok && result.attempts).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
    expect(waited).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
  });

  it("never retries a server refusal", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Please accept: the terms"));
    const result = await submitWithRetry({ ...base, attempts: 5, run });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("server");
    expect(!result.ok && result.error.message).toBe("Please accept: the terms");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops as a success when confirm() reports the work already landed", async () => {
    // The case this whole module exists for: the waiver was saved and the reply
    // was lost. Retrying would be safe (the server dedupes) but asking is both
    // cheaper and faster, and it is what stops a signer being told it failed.
    const run = vi.fn().mockRejectedValue(timeoutError());
    const confirm = vi.fn().mockResolvedValue({ waiver_id: "w1" });

    const result = await submitWithRetry({ ...base, attempts: 5, run, confirm });

    expect(result).toEqual({
      ok: true,
      value: { waiver_id: "w1" },
      attempts: 1,
      confirmed: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying when confirm() says nothing landed", async () => {
    const { sleep } = recordingSleep();
    const run = vi.fn().mockRejectedValueOnce(timeoutError()).mockResolvedValue("saved");
    const confirm = vi.fn().mockResolvedValue(null);

    const result = await submitWithRetry({ ...base, sleep, attempts: 3, run, confirm });

    expect(result.ok && result.value).toBe("saved");
    expect(result.ok && result.confirmed).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("hands confirm() its own abort signal, never an already-aborted one", async () => {
    // Without a signal of its own a stalled confirmation never rejects, so the
    // whole submission parks on "checking..." forever with the retries it exists
    // to shortcut never running. Sharing the attempt's signal would be just as
    // bad: that one has already fired.
    const { sleep } = recordingSleep();
    const signals: AbortSignal[] = [];
    const attemptSignal = AbortSignal.abort();

    await submitWithRetry({
      ...base,
      sleep,
      attempts: 2,
      createSignal: (ms) => (ms === 10_000 ? new AbortController().signal : attemptSignal),
      confirmTimeoutMs: 10_000,
      run: async () => {
        throw timeoutError();
      },
      confirm: async (signal) => {
        signals.push(signal);
        return null;
      },
    });

    expect(signals).toHaveLength(2);
    for (const s of signals) expect(s.aborted).toBe(false);
  });

  it("survives a confirm() that itself fails", async () => {
    const { sleep } = recordingSleep();
    const run = vi.fn().mockRejectedValueOnce(timeoutError()).mockResolvedValue("saved");
    const confirm = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitWithRetry({ ...base, sleep, attempts: 3, run, confirm });

    expect(result.ok && result.value).toBe("saved");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget and reports the last failure", async () => {
    const { waited, sleep } = recordingSleep();
    const run = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitWithRetry({ ...base, sleep, attempts: 3, run });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("network");
    expect(!result.ok && result.attempts).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
    // Two waits for three attempts: it never sleeps after the final one.
    expect(waited).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
  });

  it("waits for the connection to come back instead of spending an attempt", async () => {
    let online = false;
    const waitForOnline = vi.fn(async () => {
      online = true;
    });
    const run = vi.fn().mockResolvedValue("saved");
    const states: string[] = [];

    const result = await submitWithRetry({
      ...base,
      isOnline: () => online,
      waitForOnline,
      attempts: 3,
      run,
      onState: (s) => states.push(s.phase),
    });

    expect(result.ok && result.value).toBe("saved");
    expect(result.ok && result.attempts).toBe(1);
    expect(waitForOnline).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["offline", "submitting"]);
  });

  it("reports each phase in order so the page can narrate it", async () => {
    const { sleep } = recordingSleep();
    const states: string[] = [];
    const run = vi.fn().mockRejectedValueOnce(timeoutError()).mockResolvedValue("saved");

    await submitWithRetry({
      ...base,
      sleep,
      attempts: 3,
      run,
      confirm: async () => null,
      onState: (s) => states.push(s.phase),
    });

    expect(states).toEqual(["submitting", "confirming", "retrying", "submitting"]);
  });
});
