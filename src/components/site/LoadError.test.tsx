import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LoadError } from "./LoadError";

describe("LoadError", () => {
  it("names what failed and offers the retry", async () => {
    const onRetry = vi.fn();
    render(<LoadError what="The waivers" onRetry={onRetry} />);

    expect(screen.getByText(/The waivers could not be loaded\./)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says an empty list would have meant something else", () => {
    // The whole reason this component exists. Without the sentence, a manager
    // reading a screen with nothing on it cannot tell a broken load from a
    // genuinely empty one.
    render(<LoadError what="The waivers" onRetry={() => {}} />);
    expect(screen.getByText(/not the same as having nothing here/)).toBeVisible();
  });

  it("takes a caller's wording for that, where the screen has better words", () => {
    render(
      <LoadError
        what="The messages"
        notEmpty="This is not the same as having no messages."
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/not the same as having no messages/)).toBeVisible();
  });

  it("shows the underlying detail when there is one", () => {
    render(<LoadError what="The waivers" detail="Network request failed." onRetry={() => {}} />);
    expect(screen.getByText(/Network request failed\./)).toBeVisible();
  });

  it("announces itself, and does so as an alert", () => {
    // Not role=status: somebody who has tabbed away still needs to hear that
    // the thing they were waiting for is not coming.
    render(<LoadError what="The waivers" onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toBeVisible();
  });
});
