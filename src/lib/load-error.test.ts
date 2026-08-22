import { describe, expect, it } from "vitest";

import { describeLoadError } from "./load-error";

describe("describeLoadError", () => {
  it("uses what the failure said", () => {
    expect(describeLoadError(new Error("Forbidden"), "Fallback")).toBe("Forbidden");
  });

  it("falls back when the Error carries no message", () => {
    expect(describeLoadError(new Error("   "), "Could not load the waivers")).toBe(
      "Could not load the waivers",
    );
  });

  it("falls back for anything that is not an Error", () => {
    expect(describeLoadError("boom", "Could not load the waivers")).toBe(
      "Could not load the waivers",
    );
    expect(describeLoadError(undefined, "Could not load the waivers")).toBe(
      "Could not load the waivers",
    );
  });
});
