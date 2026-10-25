// Approving here hands an assistant a full sign-in as this person, so what is
// pinned is who is offered Approve at all, and that the screen says where the
// approval is going. The router, the site chrome and Supabase are mocked out.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const getAuthorizationDetails = vi.fn();
const approveAuthorization = vi.fn();
const denyAuthorization = vi.fn();
const rpc = vi.fn();
const getSession = vi.fn();
const signOut = vi.fn();
const invalidate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children, to, ...rest }: { children: ReactNode; to?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  redirect: (opts: unknown) => ({ redirect: opts }),
  useRouter: () => ({ invalidate }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => getSession(...a),
      signOut: (...a: unknown[]) => signOut(...a),
      oauth: {
        getAuthorizationDetails: (...a: unknown[]) => getAuthorizationDetails(...a),
        approveAuthorization: (...a: unknown[]) => approveAuthorization(...a),
        denyAuthorization: (...a: unknown[]) => denyAuthorization(...a),
      },
    },
    rpc: (...a: unknown[]) => rpc(...a),
  },
}));

vi.mock("@/components/site/SiteLayout", () => ({
  SiteLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

type Loaded = Record<string, unknown>;
type RouteOpts = {
  loader: (args: { deps: { authorizationId: string } }) => Promise<Loaded>;
  component: () => ReactNode;
  errorComponent: () => ReactNode;
  useLoaderData: () => Loaded;
  useSearch: () => { authorization_id: string };
};

const { Route } = await import("./[.]lovable.oauth.consent");
const route = Route as unknown as RouteOpts;

const DETAILS = {
  authorization_id: "auth-1",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  client: { id: "c1", name: "Claude", uri: "", logo_uri: "" },
  user: { id: "u1", email: "manager@example.com" },
  scope: "",
};

function renderWith(data: Loaded) {
  route.useLoaderData = () => data;
  route.useSearch = () => ({ authorization_id: "auth-1" });
  const Consent = route.component;
  return render(<Consent />);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({
    data: { session: { user: { id: "u1", email: "manager@example.com" } } },
  });
});

describe("consent loader", () => {
  it("says there is nothing to approve without a request", async () => {
    await expect(route.loader({ deps: { authorizationId: "" } })).resolves.toEqual({
      state: "missing",
    });
    expect(getAuthorizationDetails).not.toHaveBeenCalled();
  });

  it("sends an already-approved assistant straight back to a manager", async () => {
    getAuthorizationDetails.mockResolvedValue({
      data: { redirect_url: "https://claude.ai/cb?code=x" },
      error: null,
    });
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(route.loader({ deps: { authorizationId: "auth-1" } })).rejects.toEqual({
      redirect: { href: "https://claude.ai/cb?code=x" },
    });
  });

  // The shortcut used to run before the role check, so somebody who approved
  // an assistant as a member, or as a manager since demoted, was handed
  // straight back with a fresh code.
  it("never passes a non-manager back to an assistant they approved earlier", async () => {
    getAuthorizationDetails.mockResolvedValue({
      data: { redirect_url: "https://claude.ai/cb?code=x" },
      error: null,
    });
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(route.loader({ deps: { authorizationId: "auth-1" } })).resolves.toEqual({
      state: "not-manager",
      clientName: "An assistant",
      email: "manager@example.com",
      canCancel: false,
    });
  });

  it("checks the manager role for the person signing in", async () => {
    getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(route.loader({ deps: { authorizationId: "auth-1" } })).resolves.toEqual({
      state: "ready",
      clientName: "Claude",
      email: "manager@example.com",
      target: { kind: "website", host: "claude.ai" },
    });
    expect(rpc).toHaveBeenCalledWith("has_role", { _user_id: "u1", _role: "manager" });
  });

  it("marks a non-manager so they are never offered Approve", async () => {
    getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(route.loader({ deps: { authorizationId: "auth-1" } })).resolves.toMatchObject({
      state: "not-manager",
      clientName: "Claude",
      canCancel: true,
    });
  });

  it("fails rather than guessing when the role check fails", async () => {
    getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    rpc.mockResolvedValue({ data: null, error: new Error("offline") });
    await expect(route.loader({ deps: { authorizationId: "auth-1" } })).rejects.toThrow("offline");
  });
});

describe("consent screen", () => {
  it("names where the approval is going", () => {
    renderWith({
      state: "ready",
      clientName: "Claude",
      email: "manager@example.com",
      target: { kind: "website", host: "claude.ai" },
    });
    expect(screen.getByText(/access is sent to/)).toHaveTextContent("claude.ai");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("refuses to approve when it cannot say where access goes", () => {
    renderWith({
      state: "ready",
      clientName: "Claude Code",
      email: "manager@example.com",
      target: { kind: "unknown" },
    });
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it("offers a non-manager no Approve, only cancelling or switching login", async () => {
    denyAuthorization.mockResolvedValue({ data: { redirect_url: "" }, error: null });
    renderWith({
      state: "not-manager",
      clientName: "Claude",
      email: "member@example.com",
      canCancel: true,
    });
    expect(screen.getByRole("button", { name: "Use a different login" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel the request" }));
    expect(denyAuthorization).toHaveBeenCalledWith("auth-1", { skipBrowserRedirect: true });
    // No redirect came back, so the failure stays on screen.
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("has nothing to cancel on a request that was already approved", () => {
    renderWith({
      state: "not-manager",
      clientName: "An assistant",
      email: "member@example.com",
      canCancel: false,
    });
    expect(screen.queryByRole("button", { name: "Cancel the request" })).not.toBeInTheDocument();
  });

  it("signs out before sending somebody to sign in with another login", async () => {
    signOut.mockResolvedValue({ error: null });
    renderWith({
      state: "not-manager",
      clientName: "Claude",
      email: "member@example.com",
      canCancel: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Use a different login" }));
    expect(signOut).toHaveBeenCalled();
  });

  it("offers a retry when the request could not be opened", async () => {
    const ConsentError = route.errorComponent;
    render(<ConsentError />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(invalidate).toHaveBeenCalled();
  });
});
