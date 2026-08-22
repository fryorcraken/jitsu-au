// `/kb` used to sit on "Loading..." for good when the nav fetch failed: the
// hook reported `query.isLoading`, which is false once a query has rejected,
// and nothing downstream could see the rejection. What is pinned here is that
// a failed fetch stops being a load and starts being an error.
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const fetchNav = vi.fn();

vi.mock("@tanstack/react-start", () => ({ useServerFn: () => fetchNav }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" }, loading: false }) }));
vi.mock("@/lib/kb.functions", () => ({ listKnowledgeBase: vi.fn() }));

const { useKbNav } = await import("./useKbNav");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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
});
