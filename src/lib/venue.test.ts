import { describe, it, expect } from "vitest";
import { VENUE_NAME, VENUE_ADDRESS, GOOGLE_MAPS_URL, APPLE_MAPS_URL } from "./venue";

describe("venue", () => {
  it("exposes the display name and address", () => {
    expect(VENUE_NAME).toBe("ActivateFit Gym");
    expect(VENUE_ADDRESS).toBe("Harris Street, Ultimo NSW");
  });

  it("builds a Google Maps deep-link with an encoded query", () => {
    const url = new URL(GOOGLE_MAPS_URL);
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/search/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("query")).toContain("ActivateFit Gym");
    // The raw string must be percent-encoded (no bare spaces).
    expect(GOOGLE_MAPS_URL).not.toContain(" ");
  });

  it("builds an Apple Maps deep-link with an encoded query", () => {
    const url = new URL(APPLE_MAPS_URL);
    expect(url.origin + url.pathname).toBe("https://maps.apple.com/");
    expect(url.searchParams.get("q")).toContain("ActivateFit Gym");
    expect(APPLE_MAPS_URL).not.toContain(" ");
  });
});
