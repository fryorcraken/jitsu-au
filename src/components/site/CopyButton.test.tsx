// Copying can be refused by the browser (no secure context, a dismissed
// permission prompt), and when it is, the person still has to get the value
// somehow. This pins that the failure carries the value itself: the button is
// used in places where the string it copies is nowhere else on screen (the
// blog list copies a post URL it never prints), so a bare "copy it manually"
// would leave nothing to select.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

const { CopyButton } = await import("./CopyButton");

beforeEach(() => {
  toastError.mockReset();
});

describe("CopyButton", () => {
  it("copies the exact string it was given", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="https://jitsu.au/blog/hello" label="Copy link" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(writeText).toHaveBeenCalledWith("https://jitsu.au/blog/hello");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("puts the value in the failure message, and keeps it on screen to be selected", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="https://jitsu.au/blog/hello" label="Copy link" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(toastError).toHaveBeenCalledTimes(1);
    const [, options] = toastError.mock.calls[0] as [string, Record<string, unknown>];
    expect(String(options.description)).toContain("https://jitsu.au/blog/hello");
    // Auto-dismissing would take the value away mid-selection.
    expect(options.duration).toBe(Infinity);
    expect(options.closeButton).toBe(true);
  });

  it("uses ariaLabel as the accessible name while the visible label stays put", () => {
    render(<CopyButton text="x" label="Copy link" ariaLabel="Copy link to Hello world" />);
    const button = screen.getByRole("button", { name: "Copy link to Hello world" });
    expect(button).toHaveTextContent("Copy link");
  });

  it("leaves the label as the accessible name when no ariaLabel is given", () => {
    render(<CopyButton text="x" label="Copy reference" />);
    expect(screen.getByRole("button", { name: "Copy reference" })).toBeInTheDocument();
  });

  // A timer left running outlives the component. In a browser it sets state on
  // a tree that is gone; under the test runner it fires after jsdom has been
  // torn down, throwing outside any test body — a failure attributed to no
  // test, which exits the suite non-zero with every test reporting as passed.
  // That is a red CI run nobody can trace to a change.
  it("cancels the tick's timer when it is unmounted mid-countdown", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      const { unmount } = render(<CopyButton text="x" label="Copy link" />);

      // fireEvent inside act, not userEvent: userEvent's own timers deadlock
      // against the fake clock this test needs to count with.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      });
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
