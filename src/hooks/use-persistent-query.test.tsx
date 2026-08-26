// The behaviour that makes a launch on a bad connection paint instead of spin.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { z } from "zod";
import { usePersistentQuery } from "@/hooks/use-persistent-query";
import { cacheReviver } from "@/lib/kb-cache";
import * as localCache from "@/lib/local-cache";
import { readCache, writeCache } from "@/lib/local-cache";
import { PERSISTENT_QUERY_VERSION } from "@/hooks/use-persistent-query";

type Payload = { items: string[] };
const schema = z.object({ items: z.array(z.string()) });
const revive = cacheReviver<Payload>(schema);
const terms = { version: PERSISTENT_QUERY_VERSION, owner: "user-1", maxAgeMs: 60_000, revive };

function wrapper({ children }: { children: ReactNode }) {
  // Retries off so a rejecting query settles inside the test rather than
  // spending the default backoff.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function options(queryFn: () => Promise<Payload>, overrides: Record<string, unknown> = {}) {
  return {
    queryKey: ["thing", "user-1"],
    queryFn,
    cacheKey: "thing",
    owner: "user-1",
    maxAgeMs: 60_000,
    revive,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("usePersistentQuery", () => {
  it("has the stored answer on the very first render, with no loading state", () => {
    writeCache("thing", { items: ["from the device"] }, PERSISTENT_QUERY_VERSION, "user-1");
    // A promise that never settles: this is the "no signal" case, and the point
    // is that the screen is useful anyway.
    const { result } = renderHook(
      () => usePersistentQuery<Payload>(options(() => new Promise(() => {}))),
      {
        wrapper,
      },
    );

    // Not "after an effect" — immediately. Reading in an effect would flash the
    // spinner this exists to remove.
    expect(result.current.data).toEqual({ items: ["from the device"] });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.restoredAt).toBeGreaterThan(0);
  });

  it("replaces the stored answer with the network's, and stops calling it restored", async () => {
    writeCache("thing", { items: ["old"] }, PERSISTENT_QUERY_VERSION, "user-1");
    const { result } = renderHook(
      () =>
        usePersistentQuery<Payload>(options(async () => ({ items: ["fresh"] }), { staleTime: 0 })),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual({ items: ["fresh"] }));
    expect(result.current.restoredAt).toBeNull();
  });

  it("writes what the network returned back to the device", async () => {
    const { result } = renderHook(
      () => usePersistentQuery<Payload>(options(async () => ({ items: ["fresh"] }))),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual({ items: ["fresh"] }));
    await waitFor(() => expect(readCache("thing", terms)?.data).toEqual({ items: ["fresh"] }));
  });

  it("does not hand one person's stored answer to another", () => {
    writeCache("thing", { items: ["theirs"] }, PERSISTENT_QUERY_VERSION, "user-2");
    const { result } = renderHook(
      () => usePersistentQuery<Payload>(options(() => new Promise(() => {}))),
      { wrapper },
    );

    expect(result.current.data).toBeUndefined();
  });

  it("ignores a stored answer that no longer parses", () => {
    // Written by an older build with a different shape. Handing it to a
    // component would be a white screen on launch, which is worse than the
    // spinner.
    writeCache("thing", { items: [1, 2, 3] }, PERSISTENT_QUERY_VERSION, "user-1");
    const { result } = renderHook(
      () => usePersistentQuery<Payload>(options(() => new Promise(() => {}))),
      { wrapper },
    );

    expect(result.current.data).toBeUndefined();
  });

  it("keeps showing the stored answer when the network fails outright", async () => {
    writeCache("thing", { items: ["from the device"] }, PERSISTENT_QUERY_VERSION, "user-1");
    const { result } = renderHook(
      () =>
        usePersistentQuery<Payload>(
          options(
            async () => {
              throw new Error("offline");
            },
            { staleTime: 0 },
          ),
        ),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The whole point at the door of a gym: a failed refresh must not blank the
    // roster that was already on screen.
    expect(result.current.data).toEqual({ items: ["from the device"] });
    // And the failure must not have overwritten the good copy on the device.
    expect(readCache("thing", terms)?.data).toEqual({ items: ["from the device"] });
  });

  it("stores nothing while disabled", async () => {
    renderHook(
      () =>
        usePersistentQuery<Payload>(
          options(async () => ({ items: ["fresh"] }), { enabled: false }),
        ),
      { wrapper },
    );
    await waitFor(() => expect(window.localStorage.length).toBe(0));
  });

  it("reads the device once per key, not on every render", async () => {
    writeCache("thing", { items: ["from the device"] }, PERSISTENT_QUERY_VERSION, "user-1");
    const spy = vi.spyOn(localCache, "readCache");

    const { rerender } = renderHook(
      () => usePersistentQuery<Payload>(options(() => new Promise(() => {}))),
      { wrapper },
    );
    const afterFirst = spy.mock.calls.length;
    // Guard against this test passing vacuously: if the spy never intercepted
    // the read at all, the count below would be 0 === 0 and prove nothing.
    expect(afterFirst).toBeGreaterThan(0);
    rerender();
    rerender();
    rerender();

    // Re-reading per render means a synchronous localStorage read and a
    // JSON.parse of the whole payload on every keystroke into any field on the
    // page. The check-in screen puts a search box directly above a roster of
    // every member, which is exactly the worst case.
    expect(spy.mock.calls.length).toBe(afterFirst);
    spy.mockRestore();
  });
});
