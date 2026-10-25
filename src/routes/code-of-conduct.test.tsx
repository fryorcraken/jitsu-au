// The public code of conduct page, now that its text comes from the database.
//
// Three things are pinned. It renders the version its loader read, and signs
// with THAT version's number, which is what lets the server refuse an
// agreement to text that is no longer live. A failed read is a panel with a
// retry and no signing form. And there is no tick box: typing a name is the
// agreement, to the undertaking printed above it.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

let loaderData: { published: unknown; error: string | null };
const invalidate = vi.fn();
const getCodeOfConductSigner = vi.fn();
const acceptCodeOfConduct = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => ({}),
    useLoaderData: () => loaderData,
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => ({ invalidate }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/site/SiteLayout", () => ({
  SiteLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, session: null, loading: false }),
}));
vi.mock("@/lib/code-of-conduct.functions", () => ({
  getCodeOfConductSigner: (...args: unknown[]) => getCodeOfConductSigner(...args),
  acceptCodeOfConduct: (...args: unknown[]) => acceptCodeOfConduct(...args),
  getPublishedCodeOfConduct: vi.fn(),
}));

const { Route } = await import("./code-of-conduct");
const Page = (Route as unknown as { component: () => ReactNode }).component;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}

const PUBLISHED = {
  version: 4,
  title: "UTS Jitsu Code of Conduct",
  body_md: "# UTS Jitsu Code of Conduct\n\n## Mat etiquette\n\n- Bow when stepping onto the mat.",
};

beforeEach(() => {
  loaderData = { published: PUBLISHED, error: null };
  getCodeOfConductSigner.mockReset().mockResolvedValue({
    signer: { name: "Ada", full_name: "Ada Lovelace", email: "ada@example.com", signed_in: true },
    subject: null,
    status: { state: "unsigned", version: 4, accepted_version: null, accepted_at: null },
  });
  acceptCodeOfConduct
    .mockReset()
    .mockResolvedValue({ ok: true, accepted_at: "2026-10-23T00:00:00Z" });
});

describe("/code-of-conduct", () => {
  it("shows the version the loader read", async () => {
    renderPage();
    expect(screen.getByText("Bow when stepping onto the mat.")).toBeInTheDocument();
    expect(screen.getByText("Version 4")).toBeInTheDocument();
  });

  it("asks for a typed name only, with the undertaking it agrees to above it", async () => {
    renderPage();
    const name = await screen.findByLabelText(/type your name to sign/i);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(name).toHaveAccessibleDescription(/I agree to follow both/);
  });

  it("signs with the version that was on the screen", async () => {
    renderPage();
    await screen.findByLabelText(/type your name to sign/i);
    await userEvent.click(screen.getByRole("button", { name: /agree to the code of conduct/i }));
    expect(acceptCodeOfConduct).toHaveBeenCalledTimes(1);
    const { data } = acceptCodeOfConduct.mock.calls[0][0];
    expect(data).toMatchObject({ version: 4, signature_name: "Ada Lovelace" });
    expect(data).not.toHaveProperty("agree");
  });

  it("says so in place, with a retry and no form, when the document could not be read", async () => {
    loaderData = { published: null, error: "Could not load the code of conduct" };
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the code of conduct");
    expect(screen.queryByLabelText(/type your name to sign/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(invalidate).toHaveBeenCalled();
  });
});
