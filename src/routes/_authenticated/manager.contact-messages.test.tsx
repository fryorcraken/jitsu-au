// Deleting a message is the club destroying the only copy it holds of something
// a person wrote to it, so what is pinned here is the shape of that: nothing
// goes until a manager has read what will go and confirmed it, and a delete
// that fails leaves the message exactly where it was.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listContactMessages = vi.fn();
const markContactMessagesSeen = vi.fn();
const deleteContactMessage = vi.fn();

const sam = {
  id: "msg-1",
  name: "Sam Lee",
  email: "sam@example.com",
  subject: "Class times",
  message: "Are Tuesday classes still on?",
  created_at: "2026-08-05T10:00:00.000Z",
};
const kim = {
  ...sam,
  id: "msg-2",
  name: "Kim Tran",
  email: "kim@example.com",
  subject: null,
  message: "Do you have a beginners course?",
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/contact-messages.functions", () => ({
  listContactMessages: (...args: unknown[]) => listContactMessages(...args),
  markContactMessagesSeen: (...args: unknown[]) => markContactMessagesSeen(...args),
  deleteContactMessage: (...args: unknown[]) => deleteContactMessage(...args),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({ refresh: vi.fn() }),
}));

const { Route } = await import("./manager.contact-messages");
const ContactMessagesPage = (Route as unknown as { component: () => ReactNode }).component;

async function renderLoaded() {
  render(<ContactMessagesPage />);
  await screen.findByRole("table");
}

beforeEach(() => {
  listContactMessages.mockReset().mockResolvedValue({
    messages: [sam, kim],
    total: 2,
    truncated: false,
    seenAt: null,
    newestAt: sam.created_at,
    unreadIds: [sam.id],
  });
  markContactMessagesSeen.mockReset().mockResolvedValue({ ok: true, marker: null, skipped: false });
  deleteContactMessage.mockReset().mockResolvedValue({ ok: true, id: sam.id });
});

describe("/manager/contact-messages", () => {
  it("deletes nothing until the manager confirms", async () => {
    await renderLoaded();

    await userEvent.click(screen.getByRole("button", { name: "Delete the message from Sam Lee" }));

    expect(deleteContactMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Are Tuesday classes still on?")).toBeInTheDocument();
  });

  it("says what is destroyed, and names whose message it is", async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: "Delete the message from Sam Lee" }));

    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText(/Delete the message from Sam Lee\?/)).toBeInTheDocument();
    // The three things a manager cannot get back, in the words that matter:
    // their name, their address, and what they wrote.
    expect(dialog.getByText(/name, their email address and everything they wrote/)).toBeVisible();
    expect(dialog.getByText(/keeps no copy anywhere else/)).toBeVisible();
  });

  it("removes only the confirmed message from the list", async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: "Delete the message from Sam Lee" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    expect(deleteContactMessage).toHaveBeenCalledWith({ data: { id: "msg-1" } });
    expect(screen.queryByText("Sam Lee")).toBeNull();
    expect(screen.getByText("Kim Tran")).toBeInTheDocument();
  });

  it("keeps the message on screen when the delete fails", async () => {
    deleteContactMessage.mockRejectedValue(new Error("That message has already been deleted."));
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: "Delete the message from Sam Lee" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    // Nothing was destroyed, so the row must not vanish: a list that quietly
    // dropped it would tell a manager the message is gone when it is still on
    // file, which is the one direction this screen must never get wrong.
    expect(await screen.findByText("Sam Lee")).toBeInTheDocument();
  });
});
