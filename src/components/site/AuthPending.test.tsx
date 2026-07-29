import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AuthPending } from "./AuthPending";

describe("AuthPending", () => {
  it("always renders something visible, so a gated page is never blank", () => {
    render(<AuthPending />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  it("announces the wait politely with the caller's label", () => {
    render(<AuthPending label="Signing you in" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Signing you in");
  });
});
