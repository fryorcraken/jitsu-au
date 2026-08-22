import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LoadFailure } from "./LoadFailure";

describe("LoadFailure", () => {
  it("stays on screen as an alert rather than fading like a toast", () => {
    render(<LoadFailure what="The contact messages" onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The contact messages could not be loaded.",
    );
  });

  it("says what failed alongside the line that separates it from an empty list", () => {
    render(
      <LoadFailure
        what="The waivers"
        message="Failed to fetch"
        hint="This is not the same as nobody having signed one."
        onRetry={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Failed to fetch");
    expect(alert).toHaveTextContent("This is not the same as nobody having signed one.");
  });

  it("gives the person something to press", async () => {
    const onRetry = vi.fn();
    render(<LoadFailure what="The plans" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
