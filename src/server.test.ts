import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The SSR entry builds its two error pages by hand, outside the request
// middleware in start.ts, so they are the one place the security headers could
// quietly go missing. That matters most on the routes with a token in the path:
// the error page carries a link home, and a click on it from
// /email-settings/<token> would hand the token to the next page.

const serverEntryFetch = vi.fn();
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: (...args: unknown[]) => serverEntryFetch(...args) },
}));

async function fetchThrough(url: string): Promise<Response> {
  const { default: entry } = await import("./server");
  return entry.fetch(new Request(url), {}, {});
}

describe("SSR entry error pages", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    serverEntryFetch.mockReset();
    vi.restoreAllMocks();
  });

  it("carries the security headers when the handler throws", async () => {
    serverEntryFetch.mockRejectedValue(new Error("boom"));
    const response = await fetchThrough("https://jitsu.au/email-settings/abc123");
    expect(response.status).toBe(500);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("carries them on an h3-swallowed error too", async () => {
    serverEntryFetch.mockResolvedValue(
      new Response(JSON.stringify({ unhandled: true, message: "HTTPError" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await fetchThrough("https://jitsu.au/api/calendar/abc123");
    expect(response.status).toBe(500);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("<!doctype html>");
  });

  it("uses the site-wide policy for an ordinary page", async () => {
    serverEntryFetch.mockRejectedValue(new Error("boom"));
    const response = await fetchThrough("https://jitsu.au/about");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("passes a healthy response straight through", async () => {
    // Already been through the middleware, so it keeps whatever it was given.
    const ok = new Response("hi", { status: 200 });
    serverEntryFetch.mockResolvedValue(ok);
    expect(await fetchThrough("https://jitsu.au/about")).toBe(ok);
  });
});
