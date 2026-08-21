// Arriving here with a spent reset link is the ordinary case, not an edge one:
// links time out and people click them twice. What is pinned below is that the
// page never shows a password form it cannot save, and that what it shows
// instead stays on screen with a way to get another link.
//
// The router, the site chrome and Supabase are mocked out. What is under test
// is this page's gate on the recovery session.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const getSession = vi.fn();
const updateUser = vi.fn();
const onAuthStateChange = vi.fn();
const unsubscribe = vi.fn();
const getMyProfile = vi.fn();
const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children, to, ...rest }: { children: ReactNode; to?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => getSession(...args),
      updateUser: (...args: unknown[]) => updateUser(...args),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChange(...args),
    },
  },
}));

vi.mock("@/lib/waiver.functions", () => ({
  getMyProfile: (...args: unknown[]) => getMyProfile(...args),
}));

vi.mock("@/lib/pwned-passwords", () => ({
  lookupBreachedPassword: vi.fn().mockResolvedValue("safe"),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/components/site/SiteLayout", () => ({
  SiteLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { Route } = await import("./update-password");
const UpdatePassword = (Route as unknown as { component: () => ReactNode }).component;

const SESSION = { user: { id: "u1", email: "ada@example.com" } };

/** Hands the page a session the way the Supabase client would, whenever it asks. */
function withSession(session: unknown) {
  getSession.mockResolvedValue({ data: { session } });
}

/** The callback the page registered with `onAuthStateChange`, to fire by hand. */
function authListener(): (event: string, session: unknown) => void {
  return onAuthStateChange.mock.calls[0][0];
}

const expiredPanel = () => screen.queryByRole("alert");
const passwordField = () => screen.queryByLabelText("New password");

beforeEach(() => {
  vi.clearAllMocks();
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
  getMyProfile.mockResolvedValue({ first_name: "Ada", last_name: "Lovelace" });
  updateUser.mockResolvedValue({ error: null });
  withSession(null);
});

describe("/update-password", () => {
  it("says it is checking before the session has resolved", () => {
    getSession.mockReturnValue(new Promise(() => {}));
    render(<UpdatePassword />);
    expect(screen.getByRole("status")).toHaveTextContent(/checking your link/i);
    expect(passwordField()).not.toBeInTheDocument();
  });

  it("does not render the form when the link got us no session", async () => {
    render(<UpdatePassword />);
    await screen.findByRole("alert");
    expect(passwordField()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update password" })).not.toBeInTheDocument();
  });

  it("keeps the expired state on screen with a way to get another link", async () => {
    render(<UpdatePassword />);
    const panel = await screen.findByRole("alert");
    expect(panel).toHaveTextContent(/expired/i);
    expect(screen.getByRole("link", { name: /send me a new link/i })).toHaveAttribute(
      "href",
      "/reset-password",
    );
    expect(screen.getByRole("link", { name: /sign in with an emailed link/i })).toHaveAttribute(
      "href",
      "/auth",
    );
    // A panel, not a toast: nothing takes it away again on its own.
    const { toast } = await import("sonner");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not ask the server for a profile when there is no session", async () => {
    render(<UpdatePassword />);
    await screen.findByRole("alert");
    expect(getMyProfile).not.toHaveBeenCalled();
  });

  it("renders the form when the link carried a session", async () => {
    withSession(SESSION);
    render(<UpdatePassword />);
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(expiredPanel()).not.toBeInTheDocument();
  });

  it("clears the expired panel if the session lands a beat late", async () => {
    render(<UpdatePassword />);
    await screen.findByRole("alert");
    authListener()("PASSWORD_RECOVERY", SESSION);
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(expiredPanel()).not.toBeInTheDocument();
  });

  it("fetches the profile once when the session arrives twice", async () => {
    withSession(SESSION);
    render(<UpdatePassword />);
    await screen.findByLabelText("New password");
    authListener()("SIGNED_IN", SESSION);
    await waitFor(() => expect(getMyProfile).toHaveBeenCalledTimes(1));
  });

  it("hands back the expired panel when the session lapsed before submitting", async () => {
    withSession(SESSION);
    updateUser.mockResolvedValue({ error: { message: "Auth session missing!" } });
    render(<UpdatePassword />);
    await userEvent.type(await screen.findByLabelText("New password"), "otter kettle marina");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));

    const panel = await screen.findByRole("alert");
    expect(panel).toHaveTextContent(/expired/i);
    expect(panel).not.toHaveTextContent(/Auth session missing/);
    expect(passwordField()).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a password refusal next to the rules rather than blanking the form", async () => {
    withSession(SESSION);
    updateUser.mockResolvedValue({
      error: { message: "Password is known to be weak and easy to guess." },
    });
    render(<UpdatePassword />);
    await userEvent.type(await screen.findByLabelText("New password"), "otter kettle marina");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));

    // Matched on the alert rather than the text, because the rule list beside
    // the field mentions breaches too.
    expect(await screen.findByRole("alert")).toHaveTextContent(/public data breach/i);
    expect(passwordField()).toBeInTheDocument();
  });

  it("stops listening for the session once the page is gone", async () => {
    withSession(SESSION);
    const view = render(<UpdatePassword />);
    await screen.findByLabelText("New password");
    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
