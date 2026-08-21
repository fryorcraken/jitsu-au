import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConfirm, type ConfirmRequest } from "./use-confirm";

const REQUEST: ConfirmRequest = {
  title: "Approve this waiver?",
  description: "This copies what they signed onto their member record.",
  details: ["emails them to say their account is active", "starts their free trial"],
  footnote: "The email cannot be unsent.",
  confirmLabel: "Approve waiver",
};

/**
 * A page with one guarded action, so the tests can drive the hook the way a
 * real screen does: click, answer, and see whether the work ran.
 */
function Harness({
  request = REQUEST,
  onAnswer,
}: {
  request?: ConfirmRequest;
  onAnswer?: (answer: boolean) => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [ran, setRan] = useState<boolean | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const answer = await confirm(request);
          onAnswer?.(answer);
          setRan(answer);
        }}
      >
        Do the thing
      </button>
      <p>{ran === null ? "not asked" : ran ? "went ahead" : "stopped"}</p>
      {confirmDialog}
    </>
  );
}

describe("useConfirm", () => {
  it("asks nothing until the action is taken", () => {
    render(<Harness />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows the question, what it does, and what it cannot take back", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Approve this waiver?");
    expect(dialog).toHaveTextContent("copies what they signed onto their member record");
    expect(dialog).toHaveTextContent("emails them to say their account is active");
    expect(dialog).toHaveTextContent("starts their free trial");
    expect(dialog).toHaveTextContent("The email cannot be unsent.");
  });

  it("names the action on its button rather than saying OK", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));
    expect(await screen.findByRole("button", { name: "Approve waiver" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
  });

  it("answers true when the confirm button is pressed", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));
    await user.click(await screen.findByRole("button", { name: "Approve waiver" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
    expect(screen.getByText("went ahead")).toBeInTheDocument();
  });

  it("answers false when cancelled, so the caller stops", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });

  it("answers false when the dialog is dismissed with Escape", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });

  it("uses a custom cancel label when one is given", async () => {
    const user = userEvent.setup();
    render(<Harness request={{ ...REQUEST, cancelLabel: "Keep editing" }} />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));
    expect(await screen.findByRole("button", { name: "Keep editing" })).toBeInTheDocument();
  });

  it("leaves out the list and the footnote when there are none", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        request={{
          title: "Delete this?",
          description: "It goes for good.",
          confirmLabel: "Delete",
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Do the thing" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.querySelector("ul")).toBeNull();
    expect(dialog).toHaveTextContent("It goes for good.");
  });

  it("answers an unmounted caller rather than leaving its flow hanging", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    // A guarded action can outlive its screen: a manager clicks, then the
    // route changes under them. An `await confirm(...)` that never settles
    // would stop that flow halfway with nothing on screen to say so.
    const { unmount } = render(<Harness onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));
    await screen.findByRole("alertdialog");
    unmount();

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
  });

  it("answers the first question no when a second one takes the dialog", async () => {
    const user = userEvent.setup();
    const answers: Record<string, boolean> = {};
    function TwoQuestions() {
      const { confirm, confirmDialog } = useConfirm();
      return (
        <>
          <button
            type="button"
            onClick={async () => {
              const first = confirm({ ...REQUEST, title: "First?" });
              const second = confirm({ ...REQUEST, title: "Second?" });
              answers.first = await first;
              answers.second = await second;
            }}
          >
            Do the thing
          </button>
          {confirmDialog}
        </>
      );
    }
    render(<TwoQuestions />);
    await user.click(screen.getByRole("button", { name: "Do the thing" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Second?");
    await user.click(screen.getByRole("button", { name: "Approve waiver" }));

    await waitFor(() => expect(answers).toEqual({ first: false, second: true }));
  });
});
