// This screen is where the club's bank account is typed in, so what is pinned
// here is what leaves the page: the BSB stored as bare digits however it was
// typed, an incomplete account refused before it can be saved, and the fact that
// a manager is told, loudly, while members cannot pay.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const getClubSettings = vi.fn();
const saveClubSettings = vi.fn();
const toastError = vi.fn();

const ACCOUNT = {
  account_name: "UTS Jitsu Club Inc",
  bsb: "062000",
  account_number: "12345678",
  bank_name: "Commonwealth Bank of Australia",
  swift_bic: "CTBAAU2S",
  bank_address: "Sydney NSW 2000, Australia",
  account_holder_address: "1 Broadway, Ultimo NSW 2007",
  note: "",
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/membership.functions", () => ({
  getClubSettings: (...args: unknown[]) => getClubSettings(...args),
  saveClubSettings: (...args: unknown[]) => saveClubSettings(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

const { Route } = await import("./manager.settings");
const SettingsPage = (Route as unknown as { component: () => ReactNode }).component;

async function renderLoaded() {
  render(<SettingsPage />);
  await waitFor(() => expect(screen.getByLabelText("Account name")).toBeVisible());
}

beforeEach(() => {
  getClubSettings
    .mockReset()
    .mockResolvedValue({ details: null, legacy_instructions: "**BSB** 062-000 (old text)" });
  saveClubSettings.mockReset().mockResolvedValue({ ok: true });
  toastError.mockReset();
});

describe("/manager/settings", () => {
  it("warns that members cannot pay while no account is published", async () => {
    await renderLoaded();
    expect(screen.getByText(/members cannot see how to pay yet/i)).toBeVisible();
    // The free text these fields replaced, so the values can be copied across.
    expect(screen.getByText(/your previous instructions/i)).toBeVisible();
    expect(screen.getByText(/old text/)).toBeVisible();
  });

  // The read failing and the club never having published are different things,
  // and only one of them should put an empty form in front of a manager. An
  // empty form here invites retyping a working account from memory, which is how
  // one digit gets lost.
  it("shows an error instead of an empty form when the settings cannot be read", async () => {
    getClubSettings.mockRejectedValue(new Error("Could not read the club settings. Try again."));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());

    expect(screen.getByText(/could not load the club's payment settings/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
    // Nothing to type into means nothing to overwrite.
    expect(screen.queryByLabelText("Account name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    // And no claim about what members can see, because we do not know.
    expect(screen.queryByText(/members cannot see how to pay yet/i)).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalled();
  });

  it("drops the warning and the old text once an account exists", async () => {
    getClubSettings.mockResolvedValue({ details: ACCOUNT, legacy_instructions: "old text" });
    await renderLoaded();
    expect(screen.queryByText(/members cannot see how to pay yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/your previous instructions/i)).not.toBeInTheDocument();
  });

  it("shows a stored BSB hyphenated, and saves it back as bare digits", async () => {
    getClubSettings.mockResolvedValue({ details: ACCOUNT, legacy_instructions: "" });
    await renderLoaded();
    expect(screen.getByLabelText("BSB")).toHaveValue("062-000");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveClubSettings).toHaveBeenCalled());
    expect(saveClubSettings.mock.calls[0][0].data.bsb).toBe("062000");
  });

  it("refuses to save a half-filled account and says which box is wrong", async () => {
    await renderLoaded();
    await userEvent.type(screen.getByLabelText("Account name"), "UTS Jitsu Club Inc");
    await userEvent.type(screen.getByLabelText("BSB"), "0620");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(saveClubSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/a BSB is six digits/i)).toBeVisible();
    expect(screen.getByLabelText("BSB")).toHaveAttribute("aria-invalid", "true");
    expect(toastError).toHaveBeenCalled();
  });

  it("clears a field's complaint as soon as it is corrected", async () => {
    await renderLoaded();
    await userEvent.type(screen.getByLabelText("BSB"), "0620");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/a BSB is six digits/i)).toBeVisible();

    await userEvent.type(screen.getByLabelText("BSB"), "00");
    expect(screen.queryByText(/a BSB is six digits/i)).not.toBeInTheDocument();
  });

  it("rejects a SWIFT code of the wrong length", async () => {
    await renderLoaded();
    await userEvent.type(screen.getByLabelText("Account name"), "UTS Jitsu Club Inc");
    await userEvent.type(screen.getByLabelText("BSB"), "062000");
    await userEvent.type(screen.getByLabelText("Account number"), "12345678");
    await userEvent.type(screen.getByLabelText("Bank"), "CommBank");
    await userEvent.type(screen.getByLabelText("SWIFT/BIC code"), "CTBAAU2SX");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(saveClubSettings).not.toHaveBeenCalled();
    // Matched on the error's own wording, not on "8 or 11 characters", which
    // the field's hint also says.
    expect(screen.getByText(/like CTBAAU2S/)).toBeVisible();
    expect(screen.getByLabelText("SWIFT/BIC code")).toHaveAttribute("aria-invalid", "true");
  });

  // The preview is the member's own component, so a manager is looking at what
  // a member gets rather than at an approximation of it.
  it("previews the member's panel as the form is filled in", async () => {
    await renderLoaded();
    const preview = screen.getByText("What members see").closest("div.rounded-xl") as HTMLElement;
    expect(within(preview).getByText(/has not published its account details yet/i)).toBeVisible();

    await userEvent.type(screen.getByLabelText("Account name"), "UTS Jitsu Club Inc");
    await userEvent.type(screen.getByLabelText("BSB"), "062-000");
    await userEvent.type(screen.getByLabelText("Account number"), "12345678");
    await userEvent.type(screen.getByLabelText("Bank"), "Commonwealth Bank of Australia");

    expect(within(preview).getByText("062-000")).toBeVisible();
    expect(within(preview).getByRole("button", { name: /copy account number/i })).toBeVisible();
  });
});
