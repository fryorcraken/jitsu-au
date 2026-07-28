import { describe, expect, it } from "vitest";
import { isSignedUrlFresh, shouldFetchSignedUrl, SIGNED_URL_TTL_MS } from "./signed-url-cache";

const NOW = 1_700_000_000_000;

describe("isSignedUrlFresh", () => {
  it("is fresh inside the TTL and stale outside it", () => {
    expect(isSignedUrlFresh({ url: "u", at: NOW }, NOW)).toBe(true);
    expect(isSignedUrlFresh({ url: "u", at: NOW - SIGNED_URL_TTL_MS + 1 }, NOW)).toBe(true);
    expect(isSignedUrlFresh({ url: "u", at: NOW - SIGNED_URL_TTL_MS }, NOW)).toBe(false);
  });

  it("expires before the server's one-hour signature does", () => {
    expect(SIGNED_URL_TTL_MS).toBeLessThan(60 * 60 * 1000);
  });

  it("is never fresh with no entry and no url", () => {
    expect(isSignedUrlFresh(undefined, NOW)).toBe(false);
    expect(isSignedUrlFresh({ at: NOW }, NOW)).toBe(false);
    expect(isSignedUrlFresh({ at: NOW, error: "nope" }, NOW)).toBe(false);
  });
});

describe("shouldFetchSignedUrl", () => {
  it("fetches when nothing is cached", () => {
    expect(shouldFetchSignedUrl(undefined, NOW)).toBe(true);
  });

  it("does not refetch a fresh url", () => {
    expect(shouldFetchSignedUrl({ url: "u", at: NOW }, NOW)).toBe(false);
  });

  it("refetches a stale url, so a reopened panel never mounts an expired one", () => {
    expect(shouldFetchSignedUrl({ url: "u", at: NOW - SIGNED_URL_TTL_MS - 1 }, NOW)).toBe(true);
  });

  it("leaves a recorded error alone until the slot is cleared by a retry", () => {
    expect(shouldFetchSignedUrl({ at: NOW, error: "boom" }, NOW)).toBe(false);
    // A stale error is still an error: only clearing the slot retries.
    expect(shouldFetchSignedUrl({ at: NOW - SIGNED_URL_TTL_MS - 1, error: "boom" }, NOW)).toBe(
      false,
    );
    expect(shouldFetchSignedUrl(undefined, NOW)).toBe(true);
  });
});
