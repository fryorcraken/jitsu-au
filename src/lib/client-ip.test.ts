import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

const headers =
  (h: Record<string, string>) =>
  (name: string): string | undefined =>
    h[name];

describe("clientIp", () => {
  it("takes the first x-forwarded-for hop", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.2" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to cf-connecting-ip, then x-real-ip", () => {
    expect(clientIp(headers({ "cf-connecting-ip": "203.0.113.8" }))).toBe("203.0.113.8");
    expect(clientIp(headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("is null when no header names an address", () => {
    expect(clientIp(headers({}))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": " , " }))).toBeNull();
  });
});
