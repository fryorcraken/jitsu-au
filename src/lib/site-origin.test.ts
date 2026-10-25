import { describe, expect, it } from "vitest";
import { SITE_ORIGIN, linkOrigin } from "./site-origin";

describe("linkOrigin", () => {
  it("sends every one of the club's own hosts to the canonical origin", () => {
    for (const origin of [
      "https://utsjitsu.com.au",
      "https://www.utsjitsu.com.au",
      "https://jitsu.au",
      "https://www.jitsu.au",
      "https://sydneyjitsu.com.au",
    ]) {
      expect(linkOrigin(origin), origin).toBe(SITE_ORIGIN);
    }
  });

  it("sends a Lovable preview or the published lovable.app address to the canonical origin", () => {
    // Same app, same live database, but a host that can change or go away.
    expect(linkOrigin("https://preview--utsjitsu.lovable.app")).toBe(SITE_ORIGIN);
    expect(linkOrigin("https://utsjitsu.lovable.app")).toBe(SITE_ORIGIN);
  });

  it("keeps a loopback stack's own origin, so its links point at its own database", () => {
    expect(linkOrigin("http://localhost:4173")).toBe("http://localhost:4173");
    expect(linkOrigin("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
    expect(linkOrigin("http://[::1]:4173")).toBe("http://[::1]:4173");
    expect(linkOrigin("http://club.localhost:4173")).toBe("http://club.localhost:4173");
  });

  it("does not mistake a look-alike for loopback", () => {
    expect(linkOrigin("https://localhost.example.com")).toBe(SITE_ORIGIN);
    expect(linkOrigin("https://127.0.0.1.example.com")).toBe(SITE_ORIGIN);
  });

  it("drops anything after the origin", () => {
    expect(linkOrigin("http://localhost:4173/account")).toBe("http://localhost:4173");
  });

  it("falls back to the canonical origin when there is nothing usable", () => {
    expect(linkOrigin(undefined)).toBe(SITE_ORIGIN);
    expect(linkOrigin(null)).toBe(SITE_ORIGIN);
    expect(linkOrigin("")).toBe(SITE_ORIGIN);
    // What a browser sends as Origin from a sandboxed or opaque context.
    expect(linkOrigin("null")).toBe(SITE_ORIGIN);
  });
});
