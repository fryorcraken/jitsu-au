// `/account` is the only self-serve write path onto `profiles`, and the rules
// worth pinning are about WHICH keys leave the page, not how it looks: each
// card must send its own fields and nothing else, a blank display name must go
// out as `null` (clearing the override) rather than `""` (which the schema
// rejects), and an unset size must go out as `null` rather than "".
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const updateMyProfile = vi.fn().mockResolvedValue({ ok: true, fields: [] });

const PROFILE = {
  user_id: "u1",
  first_name: "Ada",
  middle_name: null,
  last_name: "Lovelace",
  preferred_name: null,
  display_name: null,
  date_of_birth: "1990-12-10",
  address: "1 Broadway, Ultimo NSW",
  phone: "0400000000",
  uts_student_number: null,
  emergency_contact_name: "Charles Babbage",
  emergency_contact_relationship: "Colleague",
  emergency_contact_phone: "0400000001",
  medical_notes: null,
  is_minor: false,
  guardian_name: null,
  guardian_relationship: null,
  sms_whatsapp_consent: false,
  gi_size: "4",
  belt_size: "3",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/profile.functions", () => ({
  updateMyProfile: (...args: unknown[]) => updateMyProfile(...args),
}));

vi.mock("@/lib/waiver.functions", () => ({
  getMyProfile: vi.fn().mockResolvedValue(PROFILE),
  listMyWaivers: vi.fn().mockResolvedValue([]),
  getWaiverPdfUrl: vi.fn(),
}));

vi.mock("@/lib/code-of-conduct.functions", () => ({
  getCodeOfConductSigner: vi.fn().mockResolvedValue({ status: null }),
}));

vi.mock("@/lib/email-verification.functions", () => ({
  requestMyEmailVerification: vi.fn(),
}));

vi.mock("@/lib/google-drive.functions", () => ({
  DEFAULT_FOLDER_NAME: "UTS Jitsu waivers",
  getGoogleDriveStatus: vi.fn().mockResolvedValue({ connected: false }),
  startGoogleDriveConnect: vi.fn(),
  saveGoogleDriveConnection: vi.fn(),
  disconnectGoogleDrive: vi.fn(),
  setGoogleDriveFolder: vi.fn(),
  setGoogleDriveFolderFromPicker: vi.fn(),
}));

// The picker itself is Google's; what this file pins is the wiring into it.
const mockPickDriveFolder = vi.fn();
vi.mock("@/lib/google-picker", () => ({
  pickDriveFolder: (...args: unknown[]) => mockPickDriveFolder(...args),
  preloadGooglePicker: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { updateUser: vi.fn() } },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// Mutable so the manager-only cards (Google Drive) can be rendered by the few
// tests that need them, without a second copy of this whole mock setup.
const mockRoles = { isManager: false };

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "ada@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
    session: null,
    loading: false,
  }),
  useRoles: () => ({
    roles: mockRoles.isManager ? ["manager"] : ["member"],
    loading: false,
    isManager: mockRoles.isManager,
  }),
}));

const { Route } = await import("./account");
const AccountPage = (Route as unknown as { component: () => ReactNode }).component;

/**
 * The card whose title is `title`. Three cards render a button labelled "Save",
 * so every interaction below has to be scoped to one of them. `CardTitle` is a
 * div rather than a heading, hence matching on text and walking up to the card
 * wrapper (`rounded-xl` is the Card primitive's own class).
 */
const card = (title: string): HTMLElement =>
  screen.getByText(title).closest("div.rounded-xl") as HTMLElement;

async function renderLoaded() {
  render(<AccountPage />);
  // Every editable card renders "Loading..." until the one shared profile fetch
  // resolves, so waiting for a field is waiting for all three.
  await screen.findByLabelText("Gi size");
}

beforeEach(() => {
  updateMyProfile.mockClear();
});

describe("/account", () => {
  it("fetches the profile once for all three editable cards", async () => {
    const { getMyProfile } = await import("@/lib/waiver.functions");
    await renderLoaded();
    expect(getMyProfile).toHaveBeenCalledTimes(1);
  });

  it("shows the sizes already on file, by code and measurement", async () => {
    await renderLoaded();
    expect(screen.getByLabelText("Gi size")).toHaveValue("4");
    expect(screen.getByLabelText("Belt size")).toHaveValue("3");
    // The code leads and the measurement is the parenthetical aid, never the
    // other way round: somebody who knows their size must be able to find it.
    expect(
      within(screen.getByLabelText("Gi size")).getByRole("option", { name: "4 (170 cm)" }),
    ).toBeInTheDocument();
    // "belt" on the belt option, so 240 cm does not read as a waist.
    expect(
      within(screen.getByLabelText("Belt size")).getByRole("option", { name: "3 (240 cm belt)" }),
    ).toBeInTheDocument();
  });

  it("offers 000 and 00 gi sizes but no belt below 0", async () => {
    await renderLoaded();
    const belt = within(screen.getByLabelText("Belt size"));
    expect(
      within(screen.getByLabelText("Gi size")).getByRole("option", { name: "000 (110 cm)" }),
    ).toBeInTheDocument();
    expect(belt.queryByRole("option", { name: /^000/ })).toBeNull();
    expect(belt.queryByRole("option", { name: /^00 / })).toBeNull();
  });

  it("sends only the sizing keys when the sizing card saves", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.selectOptions(screen.getByLabelText("Gi size"), "5");
    await user.click(within(card("Kit sizing")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMyProfile).toHaveBeenCalledTimes(1));
    expect(updateMyProfile).toHaveBeenCalledWith({ data: { gi_size: "5", belt_size: "3" } });
  });

  it("clears a size with null rather than an empty string", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.selectOptions(screen.getByLabelText("Belt size"), "");
    await user.click(within(card("Kit sizing")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMyProfile).toHaveBeenCalledTimes(1));
    expect(updateMyProfile).toHaveBeenCalledWith({ data: { gi_size: "4", belt_size: null } });
  });

  it("clears a blank display name with null, which is what reverts to the derived name", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    // `""` is rejected by the schema on purpose: blanking the box means "use
    // the derived name", and that is expressed as null.
    await user.type(screen.getByLabelText("Preferred name"), "Addy");
    await user.click(within(card("About you")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMyProfile).toHaveBeenCalledTimes(1));
    expect(updateMyProfile).toHaveBeenCalledWith({
      data: { preferred_name: "Addy", display_name: null },
    });
  });

  it("sends the contact card's own fields, and no others", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.clear(screen.getByLabelText("Mobile", { selector: "#account-phone" }));
    await user.type(screen.getByLabelText("Mobile", { selector: "#account-phone" }), "0411111111");
    await user.click(within(card("Contact")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMyProfile).toHaveBeenCalledTimes(1));
    expect(updateMyProfile).toHaveBeenCalledWith({
      data: {
        phone: "0411111111",
        address: "1 Broadway, Ultimo NSW",
        sms_whatsapp_consent: false,
        emergency_contact_name: "Charles Babbage",
        emergency_contact_relationship: "Colleague",
        emergency_contact_phone: "0400000001",
      },
    });
  });

  it("keeps unsaved typing in one card when a different card is saved", async () => {
    // Every card used to reset from the whole `profile` object, so saving any
    // one of them replaced that object, re-ran all three effects, and silently
    // discarded whatever the member had typed elsewhere but not yet saved.
    // Fails before the effects were scoped to each card's own fields.
    const user = userEvent.setup();
    await renderLoaded();

    const ecName = screen.getByLabelText("Name", { selector: "#account-ec-name" });
    await user.clear(ecName);
    await user.type(ecName, "Grace Hopper");
    await user.selectOptions(screen.getByLabelText("Gi size"), "6");

    // Save a card that owns neither of the fields touched above.
    await user.type(screen.getByLabelText("Preferred name"), "Addy");
    await user.click(within(card("About you")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMyProfile).toHaveBeenCalledTimes(1));

    expect(ecName).toHaveValue("Grace Hopper");
    expect(screen.getByLabelText("Gi size")).toHaveValue("6");
  });

  it("keeps Save disabled until something actually differs from what is stored", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const save = () => within(card("Kit sizing")).getByRole("button", { name: "Save" });
    expect(save()).toBeDisabled();
    expect(within(card("About you")).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(card("Contact")).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Gi size"), "5");
    expect(save()).toBeEnabled();

    // Only the card that changed wakes up.
    expect(within(card("Contact")).getByRole("button", { name: "Save" })).toBeDisabled();

    // Back to the stored value by hand: nothing differs, so nothing to save.
    await user.selectOptions(screen.getByLabelText("Gi size"), "4");
    expect(save()).toBeDisabled();
  });

  it("offers Revert only while there are unsaved changes, and puts the stored values back", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const revert = () => within(card("Contact")).queryByRole("button", { name: "Revert" });
    expect(revert()).toBeNull();

    const phone = screen.getByLabelText("Mobile", { selector: "#account-phone" });
    await user.clear(phone);
    await user.type(phone, "0499999999");
    expect(revert()).toBeInTheDocument();
    expect(within(card("Contact")).getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(revert()!);

    expect(phone).toHaveValue("0400000000");
    expect(revert()).toBeNull();
    expect(within(card("Contact")).getByRole("button", { name: "Save" })).toBeDisabled();
    // Reverting is local: it must never write anything.
    expect(updateMyProfile).not.toHaveBeenCalled();
  });

  it("does not offer empty editable cards when the profile could not be loaded", async () => {
    // A dropped connection used to be indistinguishable from "you have no
    // details": the cards rendered editable and blank, and one Save wrote those
    // blanks over a record that was there all along.
    const { getMyProfile } = await import("@/lib/waiver.functions");
    vi.mocked(getMyProfile).mockRejectedValueOnce(new Error("network"));

    render(<AccountPage />);

    await screen.findByText("We couldn't load your details");
    expect(screen.queryByLabelText("Gi size")).toBeNull();
    expect(screen.queryByLabelText("Preferred name")).toBeNull();
    expect(screen.queryByLabelText("Mobile", { selector: "#account-phone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(updateMyProfile).not.toHaveBeenCalled();
  });

  it("recovers the editable cards when the retry succeeds", async () => {
    const user = userEvent.setup();
    const { getMyProfile } = await import("@/lib/waiver.functions");
    vi.mocked(getMyProfile).mockRejectedValueOnce(new Error("network"));

    render(<AccountPage />);
    await screen.findByText("We couldn't load your details");

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("Gi size")).toHaveValue("4");
    expect(screen.queryByText("We couldn't load your details")).toBeNull();
  });

  it("offers nothing that would edit the legal name, date of birth or email", async () => {
    await renderLoaded();
    // These are evidence a signed waiver froze, or the person's identity. The
    // page says who to ask instead of pretending they are editable here.
    expect(screen.queryByLabelText(/first name/i)).toBeNull();
    expect(screen.queryByLabelText(/date of birth/i)).toBeNull();
    expect(screen.queryByLabelText(/^email$/i)).toBeNull();
    expect(screen.queryByLabelText(/medical/i)).toBeNull();
  });

  it("tells a member their contact edits do not rewrite a signed waiver", async () => {
    await renderLoaded();
    expect(
      within(card("Contact")).getByText(/does not change a waiver you have already signed/i),
    ).toBeInTheDocument();
  });

  it("keeps the media consent Save button disabled until a choice is made", async () => {
    await renderLoaded();
    expect(within(card("Photos and video")).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("lets a member record an explicit yes for media consent", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const consentCard = within(card("Photos and video"));
    await user.click(consentCard.getByRole("button", { name: "Yes, I consent" }));
    await user.click(consentCard.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMyProfile).toHaveBeenCalledTimes(1));
    expect(updateMyProfile).toHaveBeenCalledWith({ data: { media_consent: true } });
  });

  it("lets a member record an explicit no for media consent, distinct from never having answered", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const consentCard = within(card("Photos and video"));
    await user.click(consentCard.getByRole("button", { name: "No, I don't consent" }));
    await user.click(consentCard.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMyProfile).toHaveBeenCalledTimes(1));
    expect(updateMyProfile).toHaveBeenCalledWith({ data: { media_consent: false } });
  });

  it("reverts an unsaved media consent choice back to what is on file, and saves nothing", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const consentCard = within(card("Photos and video"));
    await user.click(consentCard.getByRole("button", { name: "Yes, I consent" }));
    expect(consentCard.getByRole("button", { name: "Revert" })).toBeInTheDocument();

    await user.click(consentCard.getByRole("button", { name: "Revert" }));

    expect(consentCard.queryByRole("button", { name: "Revert" })).toBeNull();
    expect(consentCard.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updateMyProfile).not.toHaveBeenCalled();
  });

  /**
   * Browsing needs an OAuth client id AND a Picker API key from the same Cloud
   * project. Offered without the key, the Google window opens, browses, and
   * then silently refuses to hand the folder back, so the manager is better
   * off being pointed at the name field than at that dead end.
   */
  describe("the Google Drive card", () => {
    async function renderConnected() {
      mockRoles.isManager = true;
      const { getGoogleDriveStatus } = await import("@/lib/google-drive.functions");
      vi.mocked(getGoogleDriveStatus).mockResolvedValue({
        connected: true,
        email: "club@jitsu.au",
        folderId: null,
        folderName: null,
      } as never);
      await renderLoaded();
      await screen.findByLabelText("Drive folder");
      return within(card("Google Drive"));
    }

    function configurePicker() {
      vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "123456789012-abc.apps.googleusercontent.com");
      vi.stubEnv("VITE_GOOGLE_PICKER_API_KEY", "AIza-key");
    }

    afterEach(async () => {
      mockRoles.isManager = false;
      const { getGoogleDriveStatus } = await import("@/lib/google-drive.functions");
      vi.mocked(getGoogleDriveStatus).mockResolvedValue({ connected: false } as never);
      mockPickDriveFolder.mockReset();
      vi.unstubAllEnvs();
    });

    it("offers browsing, and says how to select a folder, once the picker is configured", async () => {
      configurePicker();

      const driveCard = await renderConnected();

      expect(driveCard.getByRole("button", { name: "Browse in Drive" })).toBeEnabled();
      // Picker has no "choose the folder I'm in": opening a folder leaves
      // Select greyed out, which is what sent the manager round in circles.
      expect(driveCard.getByText(/click a folder once/i)).toBeInTheDocument();
    });

    it("disables browsing and points at the name field when the Picker key is missing", async () => {
      vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "123456789012-abc.apps.googleusercontent.com");
      vi.stubEnv("VITE_GOOGLE_PICKER_API_KEY", "");

      const driveCard = await renderConnected();

      // Disabled rather than absent: the manager is the person who can fix
      // this, and a button that vanished tells them nothing to fix.
      expect(driveCard.getByRole("button", { name: "Browse in Drive" })).toBeDisabled();
      expect(driveCard.getByText(/until this site has its google picker key/i)).toBeInTheDocument();
    });

    it("picks with the site's key, as the account the connection is on", async () => {
      // Drop `connectedEmail` and the login hint plus the whole wrong-account
      // check go quietly dead, with every picker test still green.
      configurePicker();
      mockPickDriveFolder.mockResolvedValue(null);
      const user = userEvent.setup();

      const driveCard = await renderConnected();
      await user.click(driveCard.getByRole("button", { name: "Browse in Drive" }));

      await waitFor(() => expect(mockPickDriveFolder).toHaveBeenCalledTimes(1));
      expect(mockPickDriveFolder).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "123456789012-abc.apps.googleusercontent.com",
          developerKey: "AIza-key",
          connectedEmail: "club@jitsu.au",
        }),
      );
    });

    it("gives the manager a way out while Google's window is open", async () => {
      // Google's dialog only talks back on a pick or a cancel. If it refuses
      // the pick, nothing reaches us, and without this the button would sit on
      // "Opening..." until the page was reloaded. That was the reported bug.
      configurePicker();
      mockPickDriveFolder.mockImplementation(
        (opts: { onOpen?: (close: () => void) => void }) =>
          new Promise((resolve) => opts.onOpen?.(() => resolve(null))),
      );
      const user = userEvent.setup();

      const driveCard = await renderConnected();
      await user.click(driveCard.getByRole("button", { name: "Browse in Drive" }));

      const cancel = await screen.findByRole("button", { name: "Cancel" });
      await user.click(cancel);

      await waitFor(() =>
        expect(driveCard.getByRole("button", { name: "Browse in Drive" })).toBeEnabled(),
      );
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    });

    it("keeps a failed pick on screen, where it can be read and retried", async () => {
      configurePicker();
      mockPickDriveFolder.mockRejectedValue(new Error("Google sign-in did not finish. Try again."));
      const { toast } = await import("sonner");
      vi.mocked(toast.error).mockClear();
      const user = userEvent.setup();

      const driveCard = await renderConnected();
      await user.click(driveCard.getByRole("button", { name: "Browse in Drive" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/google sign-in did not finish/i);
      // A toast would take the one instruction away after a few seconds.
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  // The password rules themselves are pinned in `lib/password-policy.test.ts`.
  // What is pinned here is the wiring: that this card actually consults them,
  // that Supabase's refusal reaches the screen in words, and that the refusal
  // gets out of the way again.
  describe("change password", () => {
    const passwordCard = () => within(card("Change password"));

    async function typePassword(user: ReturnType<typeof userEvent.setup>, value: string) {
      await user.click(passwordCard().getByLabelText("New password"));
      await user.paste(value);
    }

    it("refuses a password that breaks a rule without calling Supabase", async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const user = userEvent.setup();
      await renderLoaded();

      await typePassword(user, "Password1!");
      await user.click(passwordCard().getByRole("button", { name: "Update password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/5 more characters/);
      expect(supabase.auth.updateUser).not.toHaveBeenCalled();
    });

    it("checks the password against the name on the profile, not just the email", async () => {
      const user = userEvent.setup();
      await renderLoaded();

      // Ada Lovelace, per the profile fixture. Her own name is not a password.
      await typePassword(user, "ada lovelace ada");
      await user.click(passwordCard().getByRole("button", { name: "Update password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/knows you could guess/i);
    });

    it("puts Supabase's refusal on screen in words a person can act on", async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      vi.mocked(supabase.auth.updateUser).mockResolvedValueOnce({
        data: { user: null },
        error: {
          message: "Password is known to be weak and easy to guess, please choose a different one.",
        },
      } as unknown as Awaited<ReturnType<typeof supabase.auth.updateUser>>);
      const user = userEvent.setup();
      await renderLoaded();

      await typePassword(user, "otter kettle marina drill");
      await user.click(passwordCard().getByRole("button", { name: "Update password" }));

      const alert = await screen.findByRole("alert");
      // Not the raw message, and not a toast: it stays on screen next to the rules.
      expect(alert).toHaveTextContent(/data breach/i);
      expect(alert).not.toHaveTextContent(/known to be weak/i);
    });

    it("clears the refusal as soon as they start fixing it", async () => {
      const user = userEvent.setup();
      await renderLoaded();

      await typePassword(user, "short");
      await user.click(passwordCard().getByRole("button", { name: "Update password" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();

      await user.type(passwordCard().getByLabelText("New password"), "er");
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
