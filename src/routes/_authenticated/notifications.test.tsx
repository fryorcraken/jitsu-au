// `/notifications` merges two things that look alike and behave differently, and
// that difference is what these cases pin.
//
// An ATTENTION item is a standing problem: it clears by being fixed, so it has
// no read control at all. An ACTIVITY item is something that happened, and is
// marked read by opening the page. Blur the two and a manager gains a button
// that hides an unfixed problem, which is exactly the failure the split exists
// to prevent.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const markNotificationsRead = vi.fn().mockResolvedValue({ ok: true, marked: 0 });
const saveMyNotificationPreferences = vi.fn();
const useNotifications = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/notifications.functions", () => ({
  markNotificationsRead: (...args: unknown[]) => markNotificationsRead(...args),
  saveMyNotificationPreferences: (...args: unknown[]) => saveMyNotificationPreferences(...args),
}));

vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => useNotifications(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const { Route } = await import("./notifications");
const NotificationsPage = (Route as unknown as { component: () => ReactNode }).component;

const ATTENTION = {
  type: "define_membership_window" as const,
  title: "Set up the club's training dates",
  body: "Members cannot join as members until the club's training dates are set.",
  href: "/manager/membership-plans",
  actionLabel: "Fix it",
};

const PREFERENCES = {
  reply_to_me: true,
  thread_activity: true,
  new_blog_post: false,
  manager_comment_alerts: true,
};

function activity(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "reply" as const,
    title: "Jane L. replied to you",
    body: "See you Tuesday",
    href: "/blog/a-post#comment-1",
    read_at: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

function mockPayload(over: Record<string, unknown> = {}) {
  useNotifications.mockReturnValue({
    data: {
      attention: [],
      items: [],
      preferences: PREFERENCES,
      isManager: false,
      ...over,
    },
    loading: false,
    failed: false,
    badge: 0,
    refresh: vi.fn(),
  });
}

describe("/notifications", () => {
  beforeEach(() => {
    markNotificationsRead.mockClear();
    saveMyNotificationPreferences.mockClear();
    saveMyNotificationPreferences.mockResolvedValue(PREFERENCES);
    useNotifications.mockReset();
  });

  it("lists activity with a link to what happened", async () => {
    mockPayload({ items: [activity()] });
    render(<NotificationsPage />);

    expect(await screen.findByText("Jane L. replied to you")).toBeInTheDocument();
    expect(screen.getByText("See you Tuesday")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Jane L\. replied to you/ })).toHaveAttribute(
      "href",
      "/blog/a-post#comment-1",
    );
  });

  it("marks the notifications that were on screen read when the page opens", async () => {
    mockPayload({ items: [activity()] });
    render(<NotificationsPage />);

    await waitFor(() => expect(markNotificationsRead).toHaveBeenCalled());
    // By id, not "all of mine": a notification arriving while somebody is
    // reading must not be marked read without ever having been seen.
    expect(markNotificationsRead).toHaveBeenCalledWith({
      data: { ids: ["11111111-1111-4111-8111-111111111111"] },
    });
  });

  it("does not call the server when everything is already read", async () => {
    mockPayload({ items: [activity({ read_at: "2026-08-06T01:00:00.000Z" })] });
    render(<NotificationsPage />);

    await screen.findByText("Jane L. replied to you");
    expect(markNotificationsRead).not.toHaveBeenCalled();
  });

  // The core of the split. An attention item cannot be dismissed, so the only
  // control it offers is the one that takes you to fix it.
  it("gives an attention item somewhere to go and no way to mark it read", async () => {
    mockPayload({ attention: [ATTENTION], isManager: true });
    render(<NotificationsPage />);

    expect(await screen.findByText("Set up the club's training dates")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /fix it/i })).toHaveAttribute(
      "href",
      "/manager/membership-plans",
    );
    // "Mark all as read" belongs to Activity, and there is no unread activity
    // here, so an attention item on its own must not summon it.
    expect(screen.queryByRole("button", { name: /mark all as read/i })).not.toBeInTheDocument();
  });

  it("takes the button's wording from the item, not from the page", async () => {
    // The label used to be hardcoded "Fix it" here, which is right for unset
    // training dates and wrong for an unanswered message: nothing is broken,
    // somebody is waiting on a reply.
    mockPayload({
      attention: [
        {
          ...ATTENTION,
          type: "unread_contact_messages" as const,
          title: "Sam sent a message through the contact form",
          href: "/manager/contact-messages",
          actionLabel: "Read it",
        },
      ],
      isManager: true,
    });
    render(<NotificationsPage />);

    expect(await screen.findByRole("link", { name: /read it/i })).toHaveAttribute(
      "href",
      "/manager/contact-messages",
    );
    expect(screen.queryByRole("link", { name: /fix it/i })).not.toBeInTheDocument();
  });

  it("offers to mark activity read only while something is unread", async () => {
    mockPayload({ items: [activity({ read_at: "2026-08-06T01:00:00.000Z" })] });
    const { unmount } = render(<NotificationsPage />);
    await screen.findByText("Jane L. replied to you");
    expect(screen.queryByRole("button", { name: /mark all as read/i })).not.toBeInTheDocument();
    unmount();

    mockPayload({ items: [activity()] });
    render(<NotificationsPage />);
    expect(await screen.findByRole("button", { name: /mark all as read/i })).toBeInTheDocument();
  });

  it("shows a member no moderation switch", async () => {
    mockPayload();
    render(<NotificationsPage />);

    expect(await screen.findByLabelText("Someone replies to me")).toBeInTheDocument();
    expect(screen.queryByLabelText("New comments to review")).not.toBeInTheDocument();
  });

  it("shows a manager the moderation switch", async () => {
    mockPayload({ isManager: true });
    render(<NotificationsPage />);

    expect(await screen.findByLabelText("New comments to review")).toBeInTheDocument();
  });

  it("saves only the switch that was flipped", async () => {
    mockPayload();
    render(<NotificationsPage />);

    await userEvent.click(await screen.findByLabelText("A new blog post goes up"));

    await waitFor(() => expect(saveMyNotificationPreferences).toHaveBeenCalled());
    // One key, not the whole set: a page that sent all four could blank a
    // choice it never rendered.
    expect(saveMyNotificationPreferences).toHaveBeenCalledWith({ data: { new_blog_post: true } });
  });

  it("puts a switch back when the save fails", async () => {
    mockPayload();
    saveMyNotificationPreferences.mockRejectedValue(new Error("nope"));
    render(<NotificationsPage />);

    const toggle = await screen.findByLabelText("Someone replies to me");
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);

    // The save really was attempted, so the assertion below is about the
    // revert rather than about a click that never registered.
    await waitFor(() =>
      expect(saveMyNotificationPreferences).toHaveBeenCalledWith({ data: { reply_to_me: false } }),
    );
    // Optimistic while in flight, reverted once the failure lands. Leaving it
    // flipped would tell somebody they had turned replies off when they had not.
    await waitFor(() => expect(toggle).toBeChecked());
  });

  // A failed fetch is NOT "you have nothing waiting". Saying "all caught up"
  // over a dropped connection is the one thing this page must not do.
  it("says so honestly when it could not load", async () => {
    useNotifications.mockReturnValue({
      data: undefined,
      loading: false,
      failed: true,
      badge: 0,
      refresh: vi.fn(),
    });
    render(<NotificationsPage />);

    expect(await screen.findByText(/couldn't load your notifications/i)).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });
});
