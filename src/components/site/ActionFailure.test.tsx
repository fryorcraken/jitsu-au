import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionFailure } from "./ActionFailure";

describe("ActionFailure", () => {
  it("announces the failure and says what state it left", () => {
    render(
      <ActionFailure
        title="Undoing that check-in did not finish."
        message="That membership is one session short."
        onDismiss={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Undoing that check-in did not finish.");
    expect(alert).toHaveTextContent("That membership is one session short.");
  });

  // A retry is the wrong answer for what this panel is for: the first half of
  // the action already happened.
  it("offers no retry, only a way to put it away", () => {
    const onDismiss = vi.fn();
    render(<ActionFailure title="t" message="m" onDismiss={onDismiss} />);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
