// What this page says when things go wrong, which is most of what it does.
//
// The page is reached with a cookie somebody else's email handed them, so it has
// four ways to not show the switches, and telling them apart is the whole point:
//
//   - the link was never usable, or has been replaced  -> "no longer live"
//   - the session ran out while they sat on the page   -> "open too long"
//   - the read never landed                            -> a retry, NOT either of
//     the above, because sending somebody on bad reception to find a newer
//     email is sending them to fail the same way twice
//   - a save never landed -> the switch goes back, and what stays on screen must
//     not claim nothing was saved: a reply lost on the way back means we do not
//     know.
//
// The router and the site chrome are mocked out. What is under test is this
// page's own state machine over the two server functions.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const loadPrefs = vi.fn();
const savePrefs = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children, to, ...rest }: { children: ReactNode; to?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@tanstack/react-start", () => ({
  // The page picks its function up through `useServerFn`; hand back the spy
  // that stands in for whichever one it asked for.
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/notifications.functions", () => ({
  getEmailSettingsPreferences: (...args: unknown[]) => loadPrefs(...args),
  saveEmailSettingsPreferences: (...args: unknown[]) => savePrefs(...args),
}));

vi.mock("@/components/site/SiteLayout", () => ({
  SiteLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { Route } = await import("./index");
const EmailSettings = (Route as unknown as { component: () => ReactNode }).component;

const PREFS = {
  reply_to_me: true,
  thread_activity: true,
  new_blog_post: false,
  manager_comment_alerts: false,
};

beforeEach(() => {
  loadPrefs.mockReset();
  savePrefs.mockReset();
});

describe("the signed-out email settings page", () => {
  it("shows the switches for somebody who arrived with a live link", async () => {
    loadPrefs.mockResolvedValue({ ok: true, preferences: PREFS });
    render(<EmailSettings />);
    expect(await screen.findByText("What we email you")).toBeInTheDocument();
    // And no manager-only switch, which this page cannot honestly offer.
    expect(screen.queryByText("New comments to review")).not.toBeInTheDocument();
  });

  it("announces that it is still loading, for a reader who cannot see a spinner", async () => {
    loadPrefs.mockReturnValue(new Promise(() => {}));
    render(<EmailSettings />);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading your email settings");
  });

  it("says the link is no longer live when the server has nothing for it", async () => {
    loadPrefs.mockResolvedValue({ ok: false });
    render(<EmailSettings />);
    expect(await screen.findByText("This link is no longer live")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/notifications",
    );
  });

  it("offers a retry, not a dead link, when the read never landed", async () => {
    // The failure this is here for: a member in transit on bad reception. The
    // uniform-response rule is about the token, and a dropped connection says
    // nothing about the token, so it must not be dressed up as an expired link.
    loadPrefs.mockRejectedValue(new Error("Failed to fetch"));
    render(<EmailSettings />);

    const panel = await screen.findByRole("alert");
    expect(panel).toHaveTextContent("Your email choices could not be loaded.");
    expect(panel).toHaveTextContent("not the same as your link having expired");
    expect(screen.queryByText("This link is no longer live")).not.toBeInTheDocument();

    loadPrefs.mockResolvedValue({ ok: true, preferences: PREFS });
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("What we email you")).toBeInTheDocument();
  });

  it("saves a flipped switch, and keeps it flipped", async () => {
    loadPrefs.mockResolvedValue({ ok: true, preferences: PREFS });
    savePrefs.mockResolvedValue({ ok: true, preferences: { ...PREFS, new_blog_post: true } });
    render(<EmailSettings />);

    const blog = await screen.findByRole("switch", { name: /new blog post/i });
    expect(blog).toHaveAttribute("aria-checked", "false");
    await userEvent.click(blog);

    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    expect(savePrefs.mock.calls[0][0]).toMatchObject({ data: { new_blog_post: true } });
    // No token in the body. It travels in the cookie now, and a body that still
    // carried one would be a second way in.
    expect(savePrefs.mock.calls[0][0].data).not.toHaveProperty("token");
    await waitFor(() => expect(blog).toHaveAttribute("aria-checked", "true"));
  });

  it("stops the page when the session ran out while it was open", async () => {
    // Not "your link is broken": they were reading their own switches a minute
    // ago, and everything they did before now is saved.
    loadPrefs.mockResolvedValue({ ok: true, preferences: PREFS });
    savePrefs.mockResolvedValue({ ok: false });
    render(<EmailSettings />);

    await userEvent.click(await screen.findByRole("switch", { name: /new blog post/i }));
    expect(await screen.findByText("This page has been open too long")).toBeInTheDocument();
    expect(screen.queryByText("What we email you")).not.toBeInTheDocument();
  });

  it("never claims nothing was saved when it could not reach us", async () => {
    // The reply can be lost after the write landed, so "nothing has changed" is
    // a claim this page is not entitled to make.
    loadPrefs.mockResolvedValue({ ok: true, preferences: PREFS });
    savePrefs.mockRejectedValue(new Error("Failed to fetch"));
    render(<EmailSettings />);

    const blog = await screen.findByRole("switch", { name: /new blog post/i });
    await userEvent.click(blog);

    const panel = await screen.findByRole("alert", {}, { timeout: 20_000 });
    expect(panel).toHaveTextContent("it may or may not have saved");
    expect(panel).not.toHaveTextContent(/nothing has changed/i);
    // Still on screen with something to press, rather than a toast that faded.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    // And back to the last value we were actually told about.
    await waitFor(() => expect(blog).toHaveAttribute("aria-checked", "false"));
  }, 30_000);
});
