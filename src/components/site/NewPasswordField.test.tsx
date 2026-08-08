import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewPasswordField } from "./NewPasswordField";

const lookupBreachedPassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pwned-passwords", () => ({ lookupBreachedPassword }));

/** The field is controlled, so tests drive it through a small host. */
function Host({ personal }: { personal?: (string | null | undefined)[] }) {
  const [value, setValue] = useState("");
  return (
    <NewPasswordField
      id="pw"
      label="New password"
      value={value}
      onChange={setValue}
      personal={personal}
    />
  );
}

function rule(text: RegExp) {
  return screen.getByText(text);
}

/** The `, met` / `, not met yet` suffix the field adds for screen readers. */
function stateOf(label: string | RegExp): string {
  const item = screen.getByText(label).closest("li");
  return item?.textContent ?? "";
}

beforeEach(() => {
  lookupBreachedPassword.mockReset();
  lookupBreachedPassword.mockResolvedValue("safe");
});

describe("NewPasswordField", () => {
  it("states every rule before anything is typed", () => {
    render(<Host />);
    expect(rule(/At least 15 characters/)).toBeInTheDocument();
    expect(rule(/Not one character or short pattern repeated/)).toBeInTheDocument();
    expect(rule(/Nothing from your name, your email, or the club's name/)).toBeInTheDocument();
    expect(rule(/public data breaches/)).toBeInTheDocument();
  });

  it("does not mark anything failed while the field is empty", () => {
    render(<Host />);
    expect(stateOf(/At least 15 characters/)).not.toContain("not met yet");
  });

  it("describes the field's rules to a screen reader", () => {
    render(<Host />);
    const field = screen.getByLabelText("New password");
    expect(field.getAttribute("aria-describedby")).toContain("pw-rules");
    expect(document.getElementById("pw-rules")).toBeInTheDocument();
  });

  it("asks the browser not to offer a saved password for a new one", () => {
    render(<Host />);
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
  });

  it("marks the length rule unmet while the password is short", async () => {
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "short");
    expect(stateOf(/At least 15 characters/)).toContain("not met yet");
  });

  it("ticks the length rule off once it is long enough", async () => {
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "otter kettle marina");
    expect(stateOf(/At least 15 characters/)).toContain(", met");
  });

  it("marks a password built from the person's email unmet", async () => {
    render(<Host personal={["samrivers@example.com"]} />);
    await userEvent.type(screen.getByLabelText("New password"), "samrivers is my name");
    expect(stateOf(/Nothing from your name/)).toContain("not met yet");
  });

  it("does not spend a breach lookup on a password that fails the basics", async () => {
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "aaaaaaaaaaaaaaaaaa");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(lookupBreachedPassword).not.toHaveBeenCalled();
  });

  it("does not claim to be checking a password it has not asked about", async () => {
    // The breach rule is unanswered either way, but only one of those two is
    // work in progress. Saying "checking" about a password too short to have
    // been sent anywhere is a spinner that never stops.
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "short");
    expect(stateOf(/public data breaches/)).not.toContain("checking");
    expect(stateOf(/public data breaches/)).not.toContain("not met yet");
  });

  it("says it is checking while a lookup is actually in flight", async () => {
    lookupBreachedPassword.mockReturnValue(new Promise(() => {}));
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "otter kettle marina");
    await waitFor(() => expect(stateOf(/public data breaches/)).toContain("checking"));
  });

  it("reports a leaked password as a failed rule", async () => {
    lookupBreachedPassword.mockResolvedValue("breached");
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "otter kettle marina");
    await waitFor(() => expect(stateOf(/public data breaches/)).toContain("not met yet"));
  });

  it("ticks the breach rule off when the lookup comes back clear", async () => {
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "otter kettle marina");
    await waitFor(() => expect(stateOf(/public data breaches/)).toContain(", met"));
  });

  it("does not blame the person when the lookup cannot run", async () => {
    lookupBreachedPassword.mockResolvedValue("unknown");
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "otter kettle marina");
    await waitFor(() => expect(stateOf(/public data breaches/)).toContain(", met"));
  });

  it("announces progress through the rules", async () => {
    render(<Host />);
    await userEvent.type(screen.getByLabelText("New password"), "otter kettle marina");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("4 of 4 password requirements met."),
    );
  });
});
