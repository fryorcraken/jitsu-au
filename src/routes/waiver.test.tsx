// Pressing Sign with something missing has to answer the same way every time.
//
// It used to answer in two voices: the browser's own `required` bubble on the
// first blank text input, and a toast, one problem at a time, for everything
// the browser cannot see (the health answers, the acknowledgement ticks, the
// signature). Which one you got depended on what you had left blank. This pins
// the two things the page now always does: name everything that is outstanding
// in a summary that stays on screen, and take the person to the first one.
//
// The router, the site chrome, Supabase and the signature pad are mocked out:
// what is under test is this page's submit guard, not any of those.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ackAnchorId } from "@/lib/waiver-required-fields";

const submitWaiverWithPdf = vi.fn();
const getCurrentWaiverTemplate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => ({}),
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/waiver.functions", () => ({
  submitWaiverWithPdf: (...args: unknown[]) => submitWaiverWithPdf(...args),
  getCurrentWaiverTemplate: (...args: unknown[]) => getCurrentWaiverTemplate(...args),
  getMyProfile: vi.fn(),
  checkWaiverSubmission: vi.fn(),
}));

// Mocked for the same reason as `waiver.functions` above: importing the real
// module pulls in `requireSupabaseAuth`, and the `@tanstack/react-start` mock
// carries no `createMiddleware`. The signed-out cases below never call it.
vi.mock("@/lib/household.functions", () => ({
  listMyDependants: vi.fn(async () => []),
}));

vi.mock("@/lib/email-verification.functions", () => ({
  redeemWaiverEmailVerification: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: null, session: null, loading: false }),
}));

vi.mock("@/components/site/SiteLayout", () => ({
  SiteLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The real pad needs a canvas 2d context, which jsdom has none of, and the
// element the summary jumps to for a drawn signature belongs to the page.
vi.mock("@/components/site/SignaturePad", () => ({
  SignaturePad: ({ ariaLabel }: { ariaLabel?: string }) => (
    <canvas aria-label={ariaLabel ?? "Signature pad"} />
  ),
}));

const { Route } = await import("./waiver");
const Waiver = (Route as unknown as { component: () => ReactNode }).component;

function renderWaiver() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Waiver />
    </QueryClientProvider>,
  );
}

/** The summary banner, once it is on screen. */
function summary() {
  return screen.getByRole("alert");
}

beforeEach(() => {
  submitWaiverWithPdf.mockReset();
  getCurrentWaiverTemplate.mockReset();
  getCurrentWaiverTemplate.mockResolvedValue({
    id: "t1",
    version: 3,
    title: "Training waiver",
    body_md: "The waiver text.",
    acknowledgements: [
      { id: "risk", label: "I accept the risks of training.", required: true },
      { id: "media", label: "Photos of me may be used.", required: false },
    ],
  });
  sessionStorage.clear();
  // jsdom implements neither, and both run on the jump to a missing field.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("/waiver missing fields", () => {
  it("says nothing is wrong before they have pressed Sign", async () => {
    renderWaiver();
    await screen.findByLabelText("First name");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists everything that is missing, and sends nothing", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/things are missing before you can sign/i);
    for (const label of [
      "First name",
      "Last name",
      "Date of birth",
      "Phone",
      "Email",
      "Address",
      "Emergency contact name",
      "Health question: prescribed drugs",
      "I accept the risks of training.",
      "Your signature",
    ]) {
      expect(within(banner).getByRole("button", { name: label })).toBeInTheDocument();
    }
    // An optional acknowledgement is not something they are missing.
    expect(within(banner).queryByRole("button", { name: /Photos of me/ })).not.toBeInTheDocument();
    expect(submitWaiverWithPdf).not.toHaveBeenCalled();
  });

  it("takes them to the first missing field, top to bottom", async () => {
    const user = userEvent.setup();
    renderWaiver();
    const firstName = await screen.findByLabelText("First name");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    await waitFor(() => expect(firstName.scrollIntoView).toHaveBeenCalled());
    expect(firstName).toHaveFocus();
  });

  it("skips over the fields that are filled in", async () => {
    const user = userEvent.setup();
    renderWaiver();
    const firstName = await screen.findByLabelText("First name");
    await user.type(firstName, "Ada");
    await user.type(screen.getByLabelText("Last name"), "Lovelace");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    await waitFor(() => expect(screen.getByLabelText("Date of birth")).toHaveFocus());
  });

  // Whatever the browser could never have checked has to behave the same way as
  // a blank text box: named in the summary, and jumped to when it is first.
  it("treats an unanswered health question like any other missing field", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");
    await user.type(screen.getByLabelText("First name"), "Ada");
    await user.type(screen.getByLabelText("Last name"), "Lovelace");
    await user.type(screen.getByLabelText("Date of birth"), "1990-01-01");
    await user.type(screen.getByLabelText("Phone"), "0400000000");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Address"), "1 Broadway");
    await user.type(screen.getByLabelText("Contact name"), "Alex");
    await user.type(screen.getByLabelText("Relationship"), "Partner");
    await user.type(screen.getByLabelText("Contact mobile"), "0400111111");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    await waitFor(() => expect(document.getElementById("drugs_yes")).toHaveFocus());
    expect(summary()).toHaveTextContent("Health question: prescribed drugs");
  });

  it("drops a field off the list as soon as it is filled in", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByRole("button", { name: "First name" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("First name"), "Ada");

    await waitFor(() =>
      expect(
        within(summary()).queryByRole("button", { name: "First name" }),
      ).not.toBeInTheDocument(),
    );
    expect(summary()).toHaveTextContent(/missing before you can sign/i);
  });

  it("jumps to a field from its line in the summary", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));
    const banner = await screen.findByRole("alert");
    await user.click(within(banner).getByRole("button", { name: "Address" }));

    await waitFor(() => expect(screen.getByLabelText("Address")).toHaveFocus());
  });

  it("marks the fields it is pointing at, for whoever lands on one", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("First name")).toHaveAttribute("aria-invalid", "true"),
    );
    // Optional fields are never marked.
    expect(screen.getByLabelText(/Middle name/)).not.toHaveAttribute("aria-invalid");
  });

  // The jump can leave the summary scrolled off screen, and a red border is a
  // colour: whoever lands on the field has to be able to read why they are here.
  // Tied to the control, not merely rendered near it, or a screen reader
  // announces an invalid field and nothing about what it wants. This has to
  // hold for the controls the browser could never have checked too, which is
  // exactly where an earlier version of this only rendered the text.
  it("gives every flagged control a message of its own, tied to the control", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("First name")).toHaveAccessibleDescription(
        "Please fill this in.",
      ),
    );
    // A radio group, a checkbox and the signature pad's wrapper, none of which
    // are inputs, and the last of which is what focus lands on while drawing.
    expect(
      screen.getByRole("radiogroup", { name: /prescribed any drugs/i }),
    ).toHaveAccessibleDescription("Answer yes or no.");
    expect(
      screen.getByRole("checkbox", { name: /I accept the risks of training/i }),
    ).toHaveAccessibleDescription("Please read this and tick it.");
    const pad = screen.getByRole("group", { name: "Your signature" });
    expect(pad).toHaveAccessibleDescription("Draw it or type your full name.");
    expect(pad).toHaveAttribute("aria-invalid", "true");
    // And the ids the messages carry are the ones the controls point at.
    expect(document.getElementById(`${ackAnchorId("risk")}_needed`)).toBeInTheDocument();
  });

  it("explains a malformed email on the field as well as in the summary", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");
    await user.type(screen.getByLabelText("Email"), "ada.example.com");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(/name@example.com/),
    );
  });

  it("catches an email that is filled in but is not an address", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");
    await user.type(screen.getByLabelText("Email"), "ada.example.com");

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByRole("button", { name: "Email" })).toBeInTheDocument();
    expect(banner).toHaveTextContent(/name@example.com/);
  });
});

// The question that replaces "work out from the date of birth whether there is
// a guardian". It comes first because it changes what the rest of the form
// asks for. See #102.
describe("/waiver, who is this for", () => {
  const chooseDependant = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      screen.getByRole("radio", { name: /My child, or someone else I look after/i }),
    );
  };

  // The end-to-end suite finds the form's fields by their own labels, and
  // Playwright's `getByLabel` matches on a substring. An option whose
  // accessible name swallows its explanation swallows the explanation's words
  // with it: "they never need an email address of their own" made this radio a
  // second match for both "Email" and "Address" on a page that has an Email
  // field and an Address field, and the journey spec stopped being able to fill
  // either. The hint is a description, which is also what a screen reader
  // should hear: the name is the option, not a paragraph about it.
  it("keeps each option's name to the option, with the hint as a description", async () => {
    renderWaiver();
    await screen.findByLabelText("First name");

    const dependant = screen.getByRole("radio", {
      name: "My child, or someone else I look after",
    });
    expect(dependant).toHaveAccessibleDescription(/never need an email address/i);
    // One Email field on the page, and it is the Email field.
    expect(screen.getAllByLabelText(/email/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/address/i)).toHaveLength(1);
  });

  it("starts on Myself, so the form is the one everybody already knows", async () => {
    renderWaiver();
    await screen.findByLabelText("First name");

    expect(screen.getByRole("radio", { name: /Myself/i })).toBeChecked();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    // No guardian block for an adult signing for themselves.
    expect(screen.queryByLabelText("Parent or guardian name")).not.toBeInTheDocument();
  });

  it("stops asking a child for an email address, and asks the guardian for theirs", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");

    await chooseDependant(user);

    // The single sentence #102 is about: a nine-year-old is never asked for an
    // email address.
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(await screen.findByLabelText(/Guardian email/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Parent or guardian name")).toBeInTheDocument();
  });

  it("asks for the guardian's email in the summary, and does not ask for the child's", async () => {
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");
    await chooseDependant(user);

    await user.click(screen.getByRole("button", { name: /Sign and download waiver/i }));

    const banner = await screen.findByRole("alert");
    expect(
      within(banner).getByRole("button", { name: "Parent or guardian email" }),
    ).toBeInTheDocument();
    expect(within(banner).queryByRole("button", { name: "Email" })).not.toBeInTheDocument();
    expect(submitWaiverWithPdf).not.toHaveBeenCalled();
  });

  it("clears the participant's details when the answer changes", async () => {
    // A form that kept the previous person's name, date of birth and health
    // answers and simply relabelled them is how the wrong person's health
    // declaration ends up on a signed document.
    const user = userEvent.setup();
    renderWaiver();
    const firstName = await screen.findByLabelText("First name");
    await user.type(firstName, "Ada");
    expect(firstName).toHaveValue("Ada");

    await chooseDependant(user);

    expect(screen.getByLabelText("First name")).toHaveValue("");
  });

  it("keeps the guardian block for a dependant born more than 18 years ago", async () => {
    // `is_minor` goes false on their eighteenth birthday, and they are no more
    // able to sign than they were the day before.
    const user = userEvent.setup();
    renderWaiver();
    await screen.findByLabelText("First name");
    await chooseDependant(user);
    await user.type(screen.getByLabelText("Date of birth"), "1990-12-10");

    expect(screen.getByLabelText("Parent or guardian name")).toBeInTheDocument();
  });
});
