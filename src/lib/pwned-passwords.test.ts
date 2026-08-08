import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Imported fresh per test rather than once at the top: the module remembers
// across calls whether the padding header was accepted, and a test that makes
// it give up must not decide the outcome of the next one.
let lookupBreachedPassword: typeof import("./pwned-passwords").lookupBreachedPassword;

/** The same hash the module computes, so a fake response can be built around it. */
function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex").toUpperCase();
}

const PASSWORD = "otter kettle marina drill";
const HASH = sha1(PASSWORD);
const PREFIX = HASH.slice(0, 5);
const SUFFIX = HASH.slice(5);

/** A range response in HIBP's format: SUFFIX:COUNT lines, CRLF separated. */
function rangeBody(entries: [string, number][]): string {
  return entries.map(([suffix, count]) => `${suffix}:${count}`).join("\r\n");
}

function respondWith(body: string, init: ResponseInit = {}) {
  const fetchMock = vi.fn(async () => new Response(body, { status: 200, ...init }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  // jsdom's `crypto` has no `subtle`, so borrow Node's WebCrypto. The module
  // reads `crypto.subtle` at call time, which is what makes this substitutable.
  if (!globalThis.crypto?.subtle) {
    vi.stubGlobal("crypto", webcrypto);
  }
  vi.resetModules();
  ({ lookupBreachedPassword } = await import("./pwned-passwords"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupBreachedPassword", () => {
  it("sends only the first five characters of the hash, never the password", async () => {
    const fetchMock = respondWith(rangeBody([["0".repeat(35), 0]]));
    await lookupBreachedPassword(PASSWORD);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${PREFIX}`);
    expect(url).not.toContain(SUFFIX);
    expect(url).not.toContain(PASSWORD);
    // Without padding the size of the response is itself a hint about which
    // prefix was asked for.
    expect(init.headers).toMatchObject({ "Add-Padding": "true" });
  });

  it("reports a password that appears in the range with a real count", async () => {
    respondWith(
      rangeBody([
        ["A".repeat(35), 3],
        [SUFFIX, 1_284],
      ]),
    );
    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("breached");
  });

  it("treats a zero count as padding rather than a sighting", async () => {
    // HIBP pads responses with decoy suffixes, and marks them with a 0 count.
    respondWith(rangeBody([[SUFFIX, 0]]));
    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("safe");
  });

  it("reports safe when the suffix is absent from the range", async () => {
    respondWith(rangeBody([["B".repeat(35), 9]]));
    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("safe");
  });

  it("returns unknown, never breached, when the service errors", async () => {
    respondWith("", { status: 503 });
    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("unknown");
  });

  it("returns unknown when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("unknown");
  });

  it("returns unknown when the request is aborted mid-flight", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(lookupBreachedPassword(PASSWORD, controller.signal)).resolves.toBe("unknown");
  });

  it("still answers when the padding header is refused, and stops sending it", async () => {
    // `Add-Padding` is not CORS-safelisted, so it forces a preflight. If that
    // preflight is refused, dropping the header has to be what happens: the
    // alternative is a lookup that returns "unknown" forever and a rule that
    // sits green while checking nothing.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.headers) throw new TypeError("Failed to fetch");
      return new Response(rangeBody([[SUFFIX, 42]]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("breached");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The refusal is remembered, so the next lookup costs one request.
    fetchMock.mockClear();
    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("breached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it("keeps sending the padding header while it is accepted", async () => {
    const fetchMock = respondWith(rangeBody([[SUFFIX, 0]]));
    await lookupBreachedPassword(PASSWORD);
    await lookupBreachedPassword(PASSWORD);
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.headers).toMatchObject({ "Add-Padding": "true" });
    }
  });

  it("does not read an abort as the padding header being refused", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(lookupBreachedPassword(PASSWORD, controller.signal)).resolves.toBe("unknown");
    // One attempt, not a retry: an abort is us cancelling, not HIBP objecting.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns unknown without WebCrypto rather than throwing", async () => {
    // Plain http, or an old browser. The server side check still applies.
    vi.stubGlobal("crypto", {});
    const fetchMock = respondWith(rangeBody([[SUFFIX, 12]]));
    await expect(lookupBreachedPassword(PASSWORD)).resolves.toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
