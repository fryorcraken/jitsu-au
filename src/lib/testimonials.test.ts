import { describe, expect, it } from "vitest";
import { hasPlaceholderContent } from "./testimonials";

describe("hasPlaceholderContent", () => {
  it("flags data that still carries a placeholder marker", () => {
    expect(
      hasPlaceholderContent([{ name: "[PLACEHOLDER reviewer]", text: "[PLACEHOLDER — ...]" }]),
    ).toBe(true);
  });

  it("also flags placeholder rating/count passed as extra strings", () => {
    const real = [{ name: "Sam", text: "Great club, welcoming coaches." }];
    expect(hasPlaceholderContent(real, "[PLACEHOLDER]")).toBe(true);
  });

  it("clears once every quote and the extra figures are real — no flag to remember", () => {
    const real = [
      { name: "Sam", text: "Great club, welcoming coaches." },
      { name: "Alex", text: "Best decision I made this year." },
    ];
    expect(hasPlaceholderContent(real, "5.0", "42")).toBe(false);
  });
});
