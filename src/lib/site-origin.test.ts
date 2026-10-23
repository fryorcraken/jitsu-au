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

  it("keeps a preview or local stack's own origin, so its links point at itself", () => {
    expect(linkOrigin("https://preview--utsjitsu.lovable.app")).toBe(
      "https://preview--utsjitsu.lovable.app",
    );
    expect(linkOrigin("http://localhost:4173")).toBe("http://localhost:4173");
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
