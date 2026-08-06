// A form must not tell someone they are on the list unless they are.
//
// The old handler treated "the promise resolved" as success and never looked at
// what came back, and a failure was a red toast that auto-dismissed. This pins
// the two guarantees the page now makes: the "You're on the list" step appears
// only for a confirmed `ok` response, and a failure leaves everything typed
// exactly where it was, with something to press.
//
// The router and the site chrome are mocked out: what is under test is this
// page's submit path, not `SiteLayout`.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const submitInterest = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children, ...rest }: { children: ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/submissions.functions", () => ({
  submitInterest: (...args: unknown[]) => submitInterest(...args),
}));

vi.mock("@/components/site/SiteLayout", () => ({
  SiteLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { Route } = await import("./register-interest");
const RegisterInterest = (Route as unknown as { component: () => ReactNode }).component;

/** Fill the two required fields and press Continue. */
async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("First name"), "Ada");
  await user.type(screen.getByLabelText("Last name"), "Lovelace");
  await user.type(screen.getByLabelText("Email"), "ada@example.com");
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

beforeEach(() => {
  submitInterest.mockReset();
});

describe("/register-interest", () => {
  it("moves to step 2 once the server confirms", async () => {
    submitInterest.mockResolvedValue({ ok: true, duplicate: false });
    const user = userEvent.setup();
    render(<RegisterInterest />);

    await fillAndSubmit(user);

    expect(await screen.findByText(/You're on the list/i)).toBeInTheDocument();
    expect(submitInterest).toHaveBeenCalledTimes(1);
  });

  it("sends a submission id so a retry cannot file the lead twice", async () => {
    submitInterest.mockResolvedValue({ ok: true, duplicate: false });
    const user = userEvent.setup();
    render(<RegisterInterest />);

    await fillAndSubmit(user);
    await screen.findByText(/You're on the list/i);

    const sent = submitInterest.mock.calls[0][0] as { data: { client_submission_id: string } };
    expect(sent.data.client_submission_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not claim success when the server answers without ok", async () => {
    // The old code never looked at the response at all, so anything that
    // resolved counted as a registration.
    submitInterest.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    render(<RegisterInterest />);

    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/You're on the list/i)).not.toBeInTheDocument();
  });

  it("keeps everything typed when the send fails, and offers a retry", async () => {
    submitInterest.mockRejectedValue(new Error("Please use a real email address."));
    const user = userEvent.setup();
    render(<RegisterInterest />);

    await fillAndSubmit(user);

    // A server refusal is shown in the server's own words: it is something the
    // person can actually fix.
    expect(await screen.findByText("Please use a real email address.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByLabelText("First name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(screen.queryByText(/You're on the list/i)).not.toBeInTheDocument();
  });

  it("retries from the same form on Try again, reusing the submission id", async () => {
    submitInterest
      .mockRejectedValueOnce(new Error("Nope."))
      .mockResolvedValue({ ok: true, duplicate: false });
    const user = userEvent.setup();
    render(<RegisterInterest />);

    await fillAndSubmit(user);
    await user.click(await screen.findByRole("button", { name: /try again/i }));

    expect(await screen.findByText(/You're on the list/i)).toBeInTheDocument();
    const first = submitInterest.mock.calls[0][0] as { data: { client_submission_id: string } };
    const second = submitInterest.mock.calls[1][0] as { data: { client_submission_id: string } };
    expect(second.data.client_submission_id).toBe(first.data.client_submission_id);
  });

  it("shows the note field straight away, with no collapsed state to open first", async () => {
    render(<RegisterInterest />);

    // Used to be behind a "Add a note" toggle that had to be clicked open.
    expect(screen.queryByRole("button", { name: /add a note/i })).not.toBeInTheDocument();
    const note = screen.getByLabelText(/got a question/i);
    expect(note).toBeVisible();
    expect(note).not.toBeRequired();
  });

  it("submits without a note filled in", async () => {
    submitInterest.mockResolvedValue({ ok: true, duplicate: false });
    const user = userEvent.setup();
    render(<RegisterInterest />);

    await fillAndSubmit(user);

    expect(await screen.findByText(/You're on the list/i)).toBeInTheDocument();
    const sent = submitInterest.mock.calls[0][0] as { data: { message: string } };
    expect(sent.data.message).toBe("");
  });

  it("disables the button while a send is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    submitInterest.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const user = userEvent.setup();
    render(<RegisterInterest />);

    await fillAndSubmit(user);

    const button = screen.getByRole("button", { name: /saving/i });
    await waitFor(() => expect(button).toBeDisabled());
    release({ ok: true, duplicate: false });
  });
});
