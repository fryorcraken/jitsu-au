// The failure message has to still be there ten seconds later.
//
// This replaced a sonner toast, and the reason is the waiver: someone whose
// signed waiver did not get through needs to be looking at that fact, with a
// button under it, not at a red banner that faded while they were reading the
// next field. Every form on the site renders its in-flight and failed states
// through this component, so this is where that contract is pinned.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubmitStatus } from "./SubmitStatus";

const base = {
  attempt: 1,
  attempts: 5,
  error: null,
  failureKind: null,
  onRetry: () => {},
};

describe("SubmitStatus", () => {
  it("shows nothing while idle, on a plain submit, or once it succeeded", () => {
    // The button's own label covers the ordinary in-flight case; a second line
    // saying the same thing is noise.
    for (const status of ["idle", "submitting", "succeeded"] as const) {
      const { container, unmount } = render(<SubmitStatus {...base} status={status} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("explains a slow connection rather than leaving a spinner unexplained", () => {
    render(<SubmitStatus {...base} status="slow" />);
    expect(screen.getByRole("status")).toHaveTextContent(/connection looks slow/i);
  });

  it("says it is checking rather than guessing", () => {
    render(<SubmitStatus {...base} status="confirming" />);
    expect(screen.getByRole("status")).toHaveTextContent(/whether that got through/i);
  });

  it("counts the retry so the wait feels finite", () => {
    render(<SubmitStatus {...base} status="retrying" attempt={2} attempts={5} />);
    expect(screen.getByRole("status")).toHaveTextContent("attempt 3 of 5");
  });

  it("tells an offline person it will send itself", () => {
    render(<SubmitStatus {...base} status="offline" />);
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i);
    expect(screen.getByRole("status")).toHaveTextContent(/as soon as you're back/i);
  });

  it("shows a connection failure as an alert that says nothing was lost", () => {
    render(
      <SubmitStatus
        {...base}
        status="failed"
        failureKind="network"
        error={new Error("Failed to fetch")}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/couldn't get through/i);
    expect(alert).toHaveTextContent(/Nothing you typed is lost/i);
    // "Failed to fetch" means nothing to a member and must never be shown.
    expect(alert).not.toHaveTextContent(/Failed to fetch/);
  });

  it("shows a server refusal in the server's own words, with no false reassurance", () => {
    // This one the person can act on, so the message is the useful part.
    render(
      <SubmitStatus
        {...base}
        status="failed"
        failureKind="server"
        error={new Error("Please accept: the terms")}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Please accept: the terms");
    expect(alert).not.toHaveTextContent(/Nothing you typed is lost/i);
  });

  it("offers a way out of the page as well as a retry", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <SubmitStatus
        {...base}
        status="failed"
        failureKind="timeout"
        error={new Error("timed out")}
        onRetry={onRetry}
        fallback={<p>You can also just turn up and sign at the gym.</p>}
      />,
    );

    expect(screen.getByText(/turn up and sign at the gym/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
