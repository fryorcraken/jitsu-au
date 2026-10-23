// The code of conduct editor.
//
// Two things are pinned. The editor never opens blank over the live document
// (saving from a failed load would publish an empty code of conduct). And the
// re-agreement choice says, in numbers and before the click, who a save will
// ask to agree again: off, nobody; on, everybody who is up to date.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listCodeOfConductVersions = vi.fn();
const saveCodeOfConduct = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/code-of-conduct.functions", () => ({
  listCodeOfConductVersions: (...args: unknown[]) => listCodeOfConductVersions(...args),
  saveCodeOfConduct: (...args: unknown[]) => saveCodeOfConduct(...args),
  setCurrentCodeOfConduct: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

const { Route } = await import("./manager.code-of-conduct");
const EditorPage = (Route as unknown as { component: () => ReactNode }).component;

const v1 = {
  id: "v1",
  version: 1,
  title: "UTS Jitsu Code of Conduct",
  body_md: "# UTS Jitsu Code of Conduct\n\n- Bow when stepping onto the mat.",
  asks_reagreement: true,
  is_current: true,
  created_at: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  listCodeOfConductVersions.mockReset();
  saveCodeOfConduct.mockReset();
  window.localStorage.clear();
});

describe("manager code of conduct editor", () => {
  it("refuses to open a blank editor over the live document when the load fails", async () => {
    listCodeOfConductVersions.mockRejectedValue(new Error("Failed to fetch"));
    render(<EditorPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("would publish an empty code of conduct");
    expect(screen.queryByLabelText(/^title$/i)).not.toBeInTheDocument();
  });

  it("opens on the live version, previewed the way members read it", async () => {
    listCodeOfConductVersions.mockResolvedValue({ versions: [v1], highest_accepted: [1, 1] });
    render(<EditorPage />);

    expect(await screen.findByDisplayValue("UTS Jitsu Code of Conduct")).toBeInTheDocument();
    expect(screen.getByText("Bow when stepping onto the mat.")).toBeInTheDocument();
    // Nothing changed and nothing asked: there is no new version to write.
    expect(screen.getByRole("button", { name: /save and publish/i })).toBeDisabled();
  });

  it("says a correction asks nobody to agree again", async () => {
    listCodeOfConductVersions.mockResolvedValue({ versions: [v1], highest_accepted: [1, 1] });
    render(<EditorPage />);
    await screen.findByDisplayValue("UTS Jitsu Code of Conduct");

    expect(screen.getByText(/everybody who has agreed stays up to date/i)).toBeInTheDocument();
  });

  it("says how many people asking will re-prompt, and asks before publishing", async () => {
    listCodeOfConductVersions.mockResolvedValue({ versions: [v1], highest_accepted: [1, 1, 1] });
    saveCodeOfConduct.mockResolvedValue({
      ok: true,
      id: "v2",
      version: 2,
      is_current: true,
      already_saved: false,
    });
    render(<EditorPage />);
    await screen.findByDisplayValue("UTS Jitsu Code of Conduct");

    await userEvent.click(screen.getByRole("checkbox", { name: /ask everyone to agree again/i }));
    expect(
      screen.getByText("3 people who agreed to an earlier version will be asked to agree again."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /save and publish/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("asks 3 people who agreed to an earlier version");
    // Nothing is written until the manager says so.
    expect(saveCodeOfConduct).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: /publish and ask again/i }));
    expect(saveCodeOfConduct).toHaveBeenCalledTimes(1);
    expect(saveCodeOfConduct.mock.calls[0][0].data).toMatchObject({
      asks_reagreement: true,
      title: "UTS Jitsu Code of Conduct",
    });
    // A retry of this press must be recognisable as the same save.
    expect(saveCodeOfConduct.mock.calls[0][0].data.client_submission_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("saves a correction without a confirm, since it asks nobody anything", async () => {
    listCodeOfConductVersions.mockResolvedValue({ versions: [v1], highest_accepted: [1] });
    saveCodeOfConduct.mockResolvedValue({
      ok: true,
      id: "v2",
      version: 2,
      is_current: true,
      already_saved: false,
    });
    render(<EditorPage />);
    const title = await screen.findByDisplayValue("UTS Jitsu Code of Conduct");
    await userEvent.type(title, "!");
    await userEvent.click(screen.getByRole("button", { name: /save and publish/i }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(saveCodeOfConduct.mock.calls[0][0].data).toMatchObject({ asks_reagreement: false });
  });
});
