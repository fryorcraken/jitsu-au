// `/kb` used to sit on "Loading..." for good when the nav fetch failed: the
// hook reported `query.isLoading`, which is false once a query has rejected,
// and nothing downstream could see the rejection. What is pinned here is that
// a failed fetch stops being a load and starts being an error.
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { PERSISTENT_QUERY_VERSION } from "@/hooks/use-persistent-query";
import { writeCache } from "@/lib/local-cache";

const fetchNav = vi.fn();

vi.mock("@tanstack/react-start", () => ({ useServerFn: () => fetchNav }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" }, loading: false }) }));
vi.mock("@/lib/kb.functions", () => ({ listKnowledgeBase: vi.fn() }));

const { useKbNav } = await import("./useKbNav");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Older than KB_NAV_STALE_TIME, so the hook actually refreshes behind it. */
const STALE_ENOUGH = () => Date.now() - 10 * 60_000;

const NAV = {
  sections: [{ slug: "start", title: "Getting started", position: 10 }],
  entries: [
    {
      slug: "your-first-class",
      title: "Your first class",
      link_path: null,
      section_slug: "start",
      position: 10,
      visibility: "members",
      version: 1,
      read_version: null,
      updated_at: "2026-08-01T00:00:00Z",
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("useKbNav", () => {
  it("reports the failure instead of loading forever", async () => {
    fetchNav.mockRejectedValue(new Error("Failed to fetch"));
    const { result } = renderHook(() => useKbNav(), { wrapper });

    await waitFor(() => expect(result.current.error).toBe("Failed to fetch"));
    expect(result.current.loading).toBe(false);
    expect(result.current.nav).toEqual([]);
  });

  it("has no error once the nav lands", async () => {
    fetchNav.mockResolvedValue({ sections: [], entries: [] });
    const { result } = renderHook(() => useKbNav(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("keeps a cached sidebar on screen when the refresh fails", async () => {
    // The trap this pins, and the reason it is worth a test: `docs/pwa.md` says
    // a screen must key its "not available" branch on having NO data, never on
    // `isError`. Reporting an error here blanked a working sidebar behind a
    // panel on exactly the bad connection the caching exists for.
    writeCache("kb-nav.u1", NAV, PERSISTENT_QUERY_VERSION, "u1", STALE_ENOUGH());
    fetchNav.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = renderHook(() => useKbNav(), { wrapper });

    await waitFor(() => expect(result.current.restoredAt).not.toBeNull());
    expect(result.current.nav).toHaveLength(1);
    expect(result.current.nav[0].entries[0].slug).toBe("your-first-class");
    // Not an error: there is a perfectly good list to read.
    expect(result.current.error).toBeNull();
  });

  it("says nothing about staleness once the refresh lands", async () => {
    writeCache("kb-nav.u1", NAV, PERSISTENT_QUERY_VERSION, "u1", STALE_ENOUGH());
    fetchNav.mockResolvedValue(NAV);

    const { result } = renderHook(() => useKbNav(), { wrapper });

    await waitFor(() => expect(result.current.nav).toHaveLength(1));
    await waitFor(() => expect(fetchNav).toHaveBeenCalled());
    expect(result.current.restoredAt).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("still reports a real failure when there is nothing cached", async () => {
    fetchNav.mockRejectedValue(new Error("Failed to fetch"));
    const { result } = renderHook(() => useKbNav(), { wrapper });

    await waitFor(() => expect(result.current.error).toBe("Failed to fetch"));
    expect(result.current.restoredAt).toBeNull();
  });
});
