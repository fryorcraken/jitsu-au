import { describe, expect, it } from "vitest";
import {
  OFFER_BANNER_STORAGE_KEY,
  isOfferBannerDismissed,
  isOfferBannerHiddenPath,
  persistOfferBannerDismissed,
} from "./offer-banner";

describe("isOfferBannerHiddenPath", () => {
  it("hides the banner on in-funnel pages", () => {
    expect(isOfferBannerHiddenPath("/register-interest")).toBe(true);
    expect(isOfferBannerHiddenPath("/waiver")).toBe(true);
  });

  it("hides on nested in-funnel paths", () => {
    expect(isOfferBannerHiddenPath("/register-interest/confirm")).toBe(true);
    expect(isOfferBannerHiddenPath("/waiver/step-2")).toBe(true);
  });

  it("shows the banner on marketing pages", () => {
    for (const path of ["/", "/about", "/pricing", "/instructors", "/first-class", "/faq"]) {
      expect(isOfferBannerHiddenPath(path)).toBe(false);
    }
  });

  it("does not treat a lookalike prefix as in-funnel", () => {
    expect(isOfferBannerHiddenPath("/waiver-info")).toBe(false);
  });
});

// A minimal in-memory Storage stand-in for the getItem/setItem surface used.
function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("isOfferBannerDismissed", () => {
  it("is false when nothing is stored", () => {
    expect(isOfferBannerDismissed(makeStorage())).toBe(false);
  });

  it("is true once the dismissal flag is set", () => {
    const storage = makeStorage({ [OFFER_BANNER_STORAGE_KEY]: "1" });
    expect(isOfferBannerDismissed(storage)).toBe(true);
  });

  it("treats a null/absent storage as not dismissed", () => {
    expect(isOfferBannerDismissed(null)).toBe(false);
    expect(isOfferBannerDismissed(undefined)).toBe(false);
  });

  it("swallows storage errors and reports not dismissed", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(isOfferBannerDismissed(throwing)).toBe(false);
  });
});

describe("persistOfferBannerDismissed", () => {
  it("writes the dismissal flag so a later read reports dismissed", () => {
    const storage = makeStorage();
    persistOfferBannerDismissed(storage);
    expect(storage.getItem(OFFER_BANNER_STORAGE_KEY)).toBe("1");
    expect(isOfferBannerDismissed(storage)).toBe(true);
  });

  it("does not throw when storage is unavailable or fails", () => {
    expect(() => persistOfferBannerDismissed(null)).not.toThrow();
    expect(() =>
      persistOfferBannerDismissed({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      }),
    ).not.toThrow();
  });
});
