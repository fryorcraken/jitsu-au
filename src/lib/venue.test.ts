import { describe, it, expect } from "vitest";
import {
  VENUE_NAME,
  VENUE_ADDRESS,
  VENUE_ADDRESS_SHORT,
  VENUE_STREET_ADDRESS,
  GOOGLE_MAPS_URL,
  APPLE_MAPS_URL,
} from "./venue";

describe("venue", () => {
  it("exposes the display name and an address with a street number", () => {
    // Pinned to the literals, deliberately. Rebuilding the expectation from the
    // same parts that compose the constant passes just as happily on "Harris
    // Street, Ultimo NSW", which is the address the site shipped with: Harris
    // Street runs about 1.8km through Ultimo and Pyrmont, so a first-timer with
    // that address has a street, not a door.
    expect(VENUE_NAME).toBe("ActivateFit Gym");
    expect(VENUE_STREET_ADDRESS).toBe("745 Harris Street");
    expect(VENUE_ADDRESS).toBe("UTS Building 4, 745 Harris Street, Ultimo NSW 2007");
    expect(VENUE_ADDRESS_SHORT).toBe("745 Harris Street, Ultimo");
  });

  it("keeps every address form built on the same street address", () => {
    expect(VENUE_STREET_ADDRESS).toMatch(/^\d+ /);
    for (const form of [VENUE_ADDRESS, VENUE_ADDRESS_SHORT]) {
      expect(form).toContain(VENUE_STREET_ADDRESS);
    }
  });

  // Both deep-links search the street address rather than the business name, so
  // they resolve on their own instead of relying on a listing whose name may not
  // match the one the site shows.
  it("builds a Google Maps deep-link with an encoded query", () => {
    const url = new URL(GOOGLE_MAPS_URL);
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/search/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("query")).toBe("745 Harris Street, Ultimo NSW 2007");
    // The raw string must be percent-encoded (no bare spaces).
    expect(GOOGLE_MAPS_URL).not.toContain(" ");
  });

  it("builds an Apple Maps deep-link with an encoded query", () => {
    const url = new URL(APPLE_MAPS_URL);
    expect(url.origin + url.pathname).toBe("https://maps.apple.com/");
    expect(url.searchParams.get("q")).toBe("745 Harris Street, Ultimo NSW 2007");
    expect(APPLE_MAPS_URL).not.toContain(" ");
  });
});
