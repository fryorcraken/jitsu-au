// The rule this hook exists to enforce: success is never assumed.
//
// Every form used to do `await serverFn()` and treat "no throw" as done, with
// the waiver going further and firing a success toast unconditionally. What the
// pages render now comes from here, so these tests pin the states they render
// from: nothing reports success unless the submit actually resolved, a refusal
// is distinguishable from a dropped connection, and one form fill keeps one
// submission id however many attempts it takes.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useResilientSubmit } from "./use-resilient-submit";

const CONFIG = { attempts: 3, timeoutMs: 50, slowAfterMs: 10_000 };

function timeoutError() {
  const err = new Error("The operation timed out.");
  err.name = "TimeoutError";
  return err;
}

describe("useResilientSubmit", () => {
  it("starts idle with a submission id and nothing in flight", () => {
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));

    expect(result.current.status).toBe("idle");
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.submissionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports success only after the submit resolves", async () => {
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));

    await act(async () => {
      const outcome = await result.current.submit({ run: async () => "saved" });
      expect(outcome.ok && outcome.value).toBe("saved");
    });

    expect(result.current.status).toBe("succeeded");
    expect(result.current.busy).toBe(false);
  });

  it("reports a server refusal without retrying, keeping the server's message", async () => {
    // What the page shows for this is the server's own words, because they are
    // something the person can act on ("Please accept: ...").
    const run = vi.fn().mockRejectedValue(new Error("Please accept: the terms"));
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));

    await act(async () => {
      const outcome = await result.current.submit({ run });
      expect(outcome.ok).toBe(false);
    });

    expect(result.current.status).toBe("failed");
    expect(result.current.failureKind).toBe("server");
    expect(result.current.error?.message).toBe("Please accept: the terms");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("marks a dropped connection as retryable, not as a refusal", async () => {
    const run = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useResilientSubmit<string>({ ...CONFIG, attempts: 2 }));

    await act(async () => {
      await result.current.submit({ run });
    });

    expect(result.current.status).toBe("failed");
    expect(result.current.failureKind).toBe("network");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("sends the same submission id on every attempt", async () => {
    // The whole safety story for retrying: without a stable id, attempt two is a
    // second signed waiver and a second round of emails.
    const seen: string[] = [];
    const run = vi.fn(async (_signal: AbortSignal, id: string) => {
      seen.push(id);
      if (seen.length < 3) throw new TypeError("Failed to fetch");
      return "saved";
    });
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));
    const id = result.current.submissionId;

    await act(async () => {
      await result.current.submit({ run });
    });

    expect(seen).toEqual([id, id, id]);
    expect(result.current.status).toBe("succeeded");
  });

  it("succeeds when confirm() finds the work already landed", async () => {
    // The case the whole change is for: the waiver was saved and the reply was
    // lost. The page must end on the success screen, not send the signer back.
    const run = vi.fn().mockRejectedValue(timeoutError());
    const confirm = vi.fn(async () => "already-saved");
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));

    await act(async () => {
      const outcome = await result.current.submit({ run, confirm });
      expect(outcome.ok && outcome.value).toBe("already-saved");
      expect(outcome.ok && outcome.confirmed).toBe(true);
    });

    expect(result.current.status).toBe("succeeded");
    expect(confirm).toHaveBeenCalledWith(result.current.submissionId);
  });

  it("adopts a submission id restored from a draft", async () => {
    const restored = "3f7c1a2e-9b4d-4c8a-8e21-5d6f0a1b2c3d";
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));

    act(() => result.current.adoptSubmissionId(restored));
    await waitFor(() => expect(result.current.submissionId).toBe(restored));

    const seen: string[] = [];
    await act(async () => {
      await result.current.submit({
        run: async (_s, id) => {
          seen.push(id);
          return "saved";
        },
      });
    });
    expect(seen).toEqual([restored]);
  });

  it("mints a new id on reset, so a fresh fill is a fresh submission", () => {
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));
    const first = result.current.submissionId;

    act(() => result.current.reset());

    expect(result.current.submissionId).not.toBe(first);
    expect(result.current.status).toBe("idle");
  });

  it("refuses a second send while one is already in flight", async () => {
    // `disabled` on the button is not enough on a phone, where a second tap can
    // land before React has re-rendered.
    let release: (v: string) => void = () => {};
    const run = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const { result } = renderHook(() => useResilientSubmit<string>(CONFIG));

    let second: Promise<unknown> | null = null;
    await act(async () => {
      const first = result.current.submit({ run });
      second = result.current.submit({ run });
      await second;
      release("saved");
      await first;
    });

    expect(run).toHaveBeenCalledTimes(1);
  });
});
