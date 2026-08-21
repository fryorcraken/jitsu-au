// The DOM half of the Markdown editors: that a button and its shortcut reach
// the same rule, and that the rules act on what is actually selected in the
// textarea. The text rules themselves are pinned in `markdown-editing.test.ts`.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor id="body" value={value} onChange={setValue} rows={4} />;
}

/** Put the caret where a person would have dragged it. */
function select(el: HTMLTextAreaElement, text: string) {
  const at = el.value.indexOf(text);
  el.setSelectionRange(at, at + text.length);
}

function editor(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("MarkdownEditor", () => {
  it("formats the selection from the toolbar", async () => {
    const user = userEvent.setup();
    render(<Harness initial="keep it tidy" />);
    select(editor(), "tidy");

    await user.click(screen.getByRole("button", { name: /^Bold/ }));

    expect(editor()).toHaveValue("keep it **tidy**");
  });

  it("names each button with the shortcut it answers to", () => {
    render(<Harness initial="" />);
    expect(screen.getByRole("button", { name: "Italic (Ctrl+I)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link (Ctrl+K)" })).toBeInTheDocument();
    // Heading has no conventional binding, so it is offered without one.
    expect(screen.getByRole("button", { name: "Heading" })).toBeInTheDocument();
  });

  it("formats the selection from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness initial="keep it tidy" />);
    const el = editor();
    el.focus();

    select(el, "tidy");
    await user.keyboard("{Control>}i{/Control}");
    expect(editor()).toHaveValue("keep it _tidy_");

    select(editor(), "tidy");
    await user.keyboard("{Control>}k{/Control}");
    expect(editor()).toHaveValue("keep it _[tidy]()_");
  });

  it("wraps the selection when a pairing character is typed, instead of replacing it", async () => {
    const user = userEvent.setup();
    render(<Harness initial="keep it tidy" />);
    const el = editor();
    el.focus();
    select(el, "tidy");

    await user.keyboard("*");

    expect(editor()).toHaveValue("keep it *tidy*");
  });

  it("carries a list on to the next line, and ends it on an empty item", async () => {
    const user = userEvent.setup();
    render(<Harness initial="- gi" />);
    const el = editor();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);

    await user.keyboard("{Enter}belt{Enter}{Enter}");

    expect(editor()).toHaveValue("- gi\n- belt\n");
  });
});
