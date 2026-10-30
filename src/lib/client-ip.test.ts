import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

const headers =
  (h: Record<string, string>) =>
  (name: string): string | undefined =>
    h[name];

describe("clientIp", () => {
  it("trusts Cloudflare's address over a forwarded-for the caller can write", () => {
    // Cloudflare appends the real address to whatever x-forwarded-for arrived,
    // so a script that sends its own gets it first in the list. Before #52 that
    // first entry won, and went into the waiver's record as the signer's IP.
    expect(
      clientIp(
        headers({
          "x-forwarded-for": "198.51.100.66, 203.0.113.7",
          "cf-connecting-ip": "203.0.113.7",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back to the first x-forwarded-for hop, then x-real-ip, off Cloudflare", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.2" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("is null when no header names an address", () => {
    expect(clientIp(headers({}))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": " , ", "cf-connecting-ip": " " }))).toBeNull();
  });
});
