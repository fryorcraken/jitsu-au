// What the reader's copy of an article is cached under, and when it starts
// being fetched.
//
// Both matter for a reason that is not obvious from the hook: articles are now
// held for minutes rather than refetched on every mount, so the key is the only
// thing keeping one reader's copy away from another's. A managers-only draft
// cached under a bare `["kb-article", slug]` would still be on screen after a
// sign-out in another tab.
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const fetchArticle = vi.fn();
const auth = { user: { id: "u1" } as { id: string } | null, loading: false };

vi.mock("@tanstack/react-start", () => ({ useServerFn: () => fetchArticle }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/kb.functions", () => ({ getKbArticle: vi.fn() }));

const { useKbArticle, useKbArticlePrefetch } = await import("./useKbArticle");

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const ARTICLE = { article: { slug: "belts", title: "Belts" }, viewer: null, redirect_to: null };

beforeEach(() => {
  fetchArticle.mockReset();
  fetchArticle.mockResolvedValue(ARTICLE);
  auth.user = { id: "u1" };
  auth.loading = false;
});

describe("useKbArticle", () => {
  it("caches under a key scoped to the reader", async () => {
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useKbArticle("belts"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(ARTICLE));
    expect(client.getQueryData(["kb-article", "u1", "belts"])).toEqual(ARTICLE);
    // The unscoped key a second reader would have shared.
    expect(client.getQueryData(["kb-article", "belts"])).toBeUndefined();
  });

  // The server resolves the reader from the request's bearer token, so asking
  // before auth has settled reads a members-only article as a signed-out
  // visitor and renders "not available to you" at somebody who is signed in.
  it("waits for auth to settle before asking", async () => {
    auth.loading = true;
    const { wrapper } = harness();
    renderHook(() => useKbArticle("belts"), { wrapper });

    await waitFor(() => expect(fetchArticle).not.toHaveBeenCalled());
  });
});

describe("useKbArticlePrefetch", () => {
  // The point of the whole hook: the sidebar knows the slug before the click,
  // so the click can land on an article that is already here.
  it("fills the cache the article query then reads from", async () => {
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useKbArticlePrefetch(), { wrapper });

    result.current("belts");
    await waitFor(() =>
      expect(client.getQueryData(["kb-article", "u1", "belts"])).toEqual(ARTICLE),
    );

    // And the reader who now opens it does not pay for it a second time.
    const { result: article } = renderHook(() => useKbArticle("belts"), { wrapper });
    expect(article.current.data).toEqual(ARTICLE);
    expect(fetchArticle).toHaveBeenCalledTimes(1);
  });

  // Safe to wire to `onMouseEnter`: a cursor running down the sidebar must not
  // fire a request per pixel.
  it("fetches an article at most once however often it is called", async () => {
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useKbArticlePrefetch(), { wrapper });

    result.current("belts");
    result.current("belts");
    await waitFor(() => expect(client.getQueryData(["kb-article", "u1", "belts"])).toBeDefined());
    result.current("belts");

    expect(fetchArticle).toHaveBeenCalledTimes(1);
  });

  // Caching the signed-out answer under the signed-in reader's key is the one
  // failure this is not allowed to have.
  it("does nothing until auth has settled", async () => {
    auth.loading = true;
    const { wrapper } = harness();
    const { result } = renderHook(() => useKbArticlePrefetch(), { wrapper });

    result.current("belts");
    await waitFor(() => expect(fetchArticle).not.toHaveBeenCalled());
  });
});
