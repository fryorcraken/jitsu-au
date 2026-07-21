import { describe, expect, it } from "vitest";

import { shouldForgetSession } from "./auth-persistence";

describe("shouldForgetSession", () => {
  it("forgets the session when the user opted out and the browser restarted", () => {
    // remember = "false" (opted out) + no session marker (browser session ended)
    expect(shouldForgetSession("false", null)).toBe(true);
  });

  it("keeps the session within the same browser session even when opted out", () => {
    expect(shouldForgetSession("false", "1")).toBe(false);
  });

  it("keeps the session when the user asked to be remembered", () => {
    expect(shouldForgetSession("true", null)).toBe(false);
    expect(shouldForgetSession("true", "1")).toBe(false);
  });

  it("keeps the session when no preference was ever recorded (default / existing users)", () => {
    expect(shouldForgetSession(null, null)).toBe(false);
    expect(shouldForgetSession(null, "1")).toBe(false);
  });
});
