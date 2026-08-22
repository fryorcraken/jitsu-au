// Replacing a calendar link breaks whatever the person has already subscribed,
// on purpose and immediately, so what is pinned here is the guard rather than
// the layout: nothing happens on the first click, the warning says what will
// stop working, and the new link stays on screen afterwards where they can act
// on it. The failure path is pinned too, because a toast there would fade while
// someone was still working out which link they now hold.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMyCalendarFeedUrl = vi.fn();
const replaceMyCalendarFeedUrl = vi.fn();

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/calendar.functions", () => ({
  getMyCalendarFeedUrl: () => getMyCalendarFeedUrl(),
  replaceMyCalendarFeedUrl: () => replaceMyCalendarFeedUrl(),
}));

const { CalendarLinkPanel } = await import("./CalendarLinkPanel");

const OLD_URL = "https://jitsu.au/api/calendar/utsj_oldoldoldold";
const NEW_URL = "https://jitsu.au/api/calendar/utsj_newnewnewnew";

beforeEach(() => {
  getMyCalendarFeedUrl.mockReset().mockResolvedValue({ url: OLD_URL });
  replaceMyCalendarFeedUrl.mockReset().mockResolvedValue({ url: NEW_URL });
});

async function renderPanel() {
  render(<CalendarLinkPanel />);
  expect(await screen.findByText(OLD_URL)).toBeInTheDocument();
}

describe("CalendarLinkPanel", () => {
  it("shows the link with a way to copy it, and something to press to replace it", async () => {
    await renderPanel();
    expect(screen.getByRole("button", { name: /copy your calendar link/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /replace link/i })).toBeEnabled();
  });

  // A blank panel while the link is fetched tells a screen reader nothing.
  it("announces that it is loading", () => {
    getMyCalendarFeedUrl.mockReturnValue(new Promise(() => {}));
    render(<CalendarLinkPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading your link/i);
  });

  // A failed load is not "you have no link". It has to stay on screen with
  // something to press, and say that nothing has changed.
  it("keeps a failed load on screen with a retry", async () => {
    getMyCalendarFeedUrl.mockRejectedValueOnce(new Error("network"));
    render(<CalendarLinkPanel />);

    // By text, not by role: the loading line is a live region too, and it is
    // the one already on screen when this starts polling.
    const failure = await screen.findByText(/couldn't load your calendar link/i);
    expect(failure).toHaveAttribute("role", "status");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText(OLD_URL)).toBeInTheDocument();
  });

  // The guard. One click opens the confirm and nothing else; the link is still
  // the old one until the second, deliberate press.
  it("does not replace anything until the confirm is accepted", async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /replace link/i }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(replaceMyCalendarFeedUrl).not.toHaveBeenCalled();
    expect(screen.getByText(OLD_URL)).toBeInTheDocument();
  });

  // Said in words, before the click: this breaks the subscription they already
  // have. That sentence is the reason the dialog exists at all.
  it("says the current link stops working before anything is pressed", async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /replace link/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/current link stops working straight away/i);
    expect(dialog).toHaveTextContent(/stops updating until you put the new link in/i);
    expect(screen.getByRole("button", { name: /keep my link/i })).toBeEnabled();
  });

  // Backing out is a click, and it changes nothing.
  it("leaves the link alone when the confirm is declined", async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /replace link/i }));
    await userEvent.click(await screen.findByRole("button", { name: /keep my link/i }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(replaceMyCalendarFeedUrl).not.toHaveBeenCalled();
    expect(screen.getByText(OLD_URL)).toBeInTheDocument();
  });

  // The other half of the UX bar: after the break they need the new link in
  // front of them, still there, with a copy button, and told plainly that the
  // old one is dead.
  it("puts the new link on screen and says the old one has stopped", async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /replace link/i }));
    // Scoped to the dialog: the button that opened it carries the same words.
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /replace link/i }));

    expect(await screen.findByText(NEW_URL)).toBeInTheDocument();
    expect(screen.queryByText(OLD_URL)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/old one has stopped working/i);
    expect(screen.getByRole("button", { name: /copy your calendar link/i })).toBeEnabled();
  });

  // A failed replace may or may not have retired the old link, so it stays in
  // the dialog with the message and the button, never a toast.
  it("keeps a failed replace in the dialog with something to press", async () => {
    replaceMyCalendarFeedUrl.mockRejectedValueOnce(new Error("nope"));
    await renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /replace link/i }));
    // Scoped to the dialog: the button that opened it carries the same words.
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /replace link/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't go through/i);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
  });
});
