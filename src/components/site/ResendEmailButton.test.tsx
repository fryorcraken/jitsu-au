// The Resend button says where an email goes before it sends, keeps the result
// on screen, and explains a refusal rather than offering a Send that will fail.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getResendPreview = vi.fn();
const resendClubEmail = vi.fn();

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/email-resend.functions", () => ({
  getResendPreview: (...args: unknown[]) => getResendPreview(...args),
  resendClubEmail: (...args: unknown[]) => resendClubEmail(...args),
}));

const { ResendEmailButton } = await import("./ResendEmailButton");

const RECORD = "7d4b6f0e-3a39-4a77-9d8b-2a1c1f0e5b11";

beforeEach(() => {
  getResendPreview.mockReset().mockResolvedValue({
    available: true,
    to: "ada@example.com",
    toBelongsTo: "Ada",
    what: "Invoice INV0007 for $85, with the club's current bank details.",
  });
  resendClubEmail
    .mockReset()
    .mockResolvedValue({ sent: true, to: "ada@example.com", toBelongsTo: "Ada" });
});

describe("ResendEmailButton", () => {
  it("says what goes to which address before anything is sent", async () => {
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} />);
    await userEvent.click(screen.getByRole("button", { name: /resend invoice/i }));

    expect(await screen.findByText(/invoice INV0007 for \$85/i)).toBeVisible();
    expect(screen.getByText("ada@example.com")).toBeVisible();
    expect(screen.getByText(/ada's address/i)).toBeVisible();
    expect(resendClubEmail).not.toHaveBeenCalled();
  });

  it("sends with a click id, and keeps the result on screen as a status", async () => {
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} />);
    await userEvent.click(screen.getByRole("button", { name: /resend invoice/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => expect(resendClubEmail).toHaveBeenCalledTimes(1));
    const { data } = resendClubEmail.mock.calls[0][0];
    expect(data).toMatchObject({ kind: "item_invoice", record_id: RECORD });
    expect(data.client_submission_id).toMatch(/[0-9a-f-]{36}/);
    expect(await screen.findByText("Sent to ada@example.com.")).toHaveAttribute("role", "status");
  });

  it("uses a new click id for the next press", async () => {
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} />);
    await userEvent.click(screen.getByRole("button", { name: /resend invoice/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));

    await waitFor(() => expect(resendClubEmail).toHaveBeenCalledTimes(2));
    const first = resendClubEmail.mock.calls[0][0].data.client_submission_id;
    const second = resendClubEmail.mock.calls[1][0].data.client_submission_id;
    expect(first).not.toBe(second);
  });

  it("says why when the email cannot be sent, with the Send disabled", async () => {
    getResendPreview.mockResolvedValue({
      available: false,
      reason: "paid",
      message: "This invoice has been paid. Resend the receipt instead.",
    });
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} />);
    await userEvent.click(screen.getByRole("button", { name: /resend invoice/i }));

    expect(await screen.findByText(/resend the receipt instead/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows the once-a-minute refusal in words", async () => {
    resendClubEmail.mockResolvedValue({
      sent: false,
      reason: "rate_limited",
      message: "This was sent less than a minute ago. You can send it again in 42 seconds.",
      retryAfterSeconds: 42,
    });
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} />);
    await userEvent.click(screen.getByRole("button", { name: /resend invoice/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));

    expect(await screen.findByText(/send it again in 42 seconds/i)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("keeps a failed send on screen with a way to try again", async () => {
    resendClubEmail.mockRejectedValue(
      new Error("We couldn't send that email just now. Try again shortly."),
    );
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} />);
    await userEvent.click(screen.getByRole("button", { name: /resend invoice/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));

    expect(
      await screen.findByRole("button", { name: /try again/i }, { timeout: 5000 }),
    ).toBeVisible();
  });

  // "Already confirmed" now comes back from the preview, before any send, so
  // the reload has to hang off the preview's answer too, or the card behind it
  // keeps saying "unverified" with a button that can never work.
  it("tells the page it is stale when the preview says the address is already confirmed", async () => {
    getResendPreview.mockResolvedValue({
      available: false,
      reason: "already_verified",
      message: "That address is already confirmed. There is nothing to send.",
    });
    const onStale = vi.fn();
    render(<ResendEmailButton kind="email_verification" recordId={RECORD} onStale={onStale} />);
    await userEvent.click(screen.getByRole("button", { name: /resend verification/i }));
    await screen.findByText(/already confirmed/i);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("does not reload the page after a send that went", async () => {
    const onStale = vi.fn();
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} onStale={onStale} />);
    await userEvent.click(screen.getByRole("button", { name: /resend invoice/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));
    await screen.findByText("Sent to ada@example.com.");
    expect(onStale).not.toHaveBeenCalled();
  });

  // A failure from the last time the panel was open is about a press the
  // manager walked away from; its Try again would retry that old press.
  it("clears an old failure when the panel is opened again", async () => {
    resendClubEmail.mockRejectedValue(
      new Error("We couldn't send that email just now. Try again shortly."),
    );
    render(<ResendEmailButton kind="item_invoice" recordId={RECORD} />);
    const trigger = screen.getByRole("button", { name: /resend invoice/i });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /try again/i }, { timeout: 5000 });

    await userEvent.keyboard("{Escape}");
    await userEvent.click(trigger);
    await screen.findByRole("button", { name: "Send" });
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});
