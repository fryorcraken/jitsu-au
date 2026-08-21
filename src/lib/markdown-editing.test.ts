import { describe, expect, it } from "vitest";
import {
  applyMarkdownCommand,
  continueListOnEnter,
  markdownShortcut,
  replacementFor,
  shortcutLabel,
  wrapWithTypedCharacter,
  type MarkdownDoc,
} from "./markdown-editing";

/** "Bold the |selection| here" — the pipes say where the selection is, so a
 * case reads as the thing a person did rather than as two integers. */
function doc(marked: string): MarkdownDoc {
  const start = marked.indexOf("|");
  const end = marked.indexOf("|", start + 1) - 1;
  return { text: marked.replace(/\|/g, ""), start, end: end < start ? start : end };
}
function show(d: MarkdownDoc): string {
  return d.start === d.end
    ? `${d.text.slice(0, d.start)}|${d.text.slice(d.start)}`
    : `${d.text.slice(0, d.start)}|${d.text.slice(d.start, d.end)}|${d.text.slice(d.end)}`;
}

describe("applyMarkdownCommand", () => {
  it("wraps the selection and keeps it selected, so a second press can nest", () => {
    expect(show(applyMarkdownCommand(doc("keep it |tidy|"), "bold"))).toBe("keep it **|tidy|**");
    expect(show(applyMarkdownCommand(doc("keep it |tidy|"), "italic"))).toBe("keep it _|tidy|_");
    expect(show(applyMarkdownCommand(doc("run |bun test|"), "code"))).toBe("run `|bun test|`");
  });

  it("takes the formatting off again when it is already there", () => {
    expect(show(applyMarkdownCommand(doc("keep it **|tidy|**"), "bold"))).toBe("keep it |tidy|");
    // Markers swept up inside the selection, e.g. by selecting the whole line.
    expect(show(applyMarkdownCommand(doc("|**tidy**|"), "bold"))).toBe("|tidy|");
  });

  it("acts on the word under the cursor when nothing is selected", () => {
    expect(show(applyMarkdownCommand(doc("keep it ti|dy"), "bold"))).toBe("keep it **|tidy|**");
    expect(show(applyMarkdownCommand(doc("keep it **ti|dy**"), "bold"))).toBe("keep it |tidy|");
  });

  it("leaves surrounding whitespace outside the markers", () => {
    // "** bold **" is not bold in Markdown, and double-clicking a word often
    // takes the space after it.
    expect(show(applyMarkdownCommand(doc("keep |it |tidy"), "bold"))).toBe("keep **|it|** tidy");
  });

  it("makes a heading, a quote and lists out of the lines the selection touches", () => {
    expect(show(applyMarkdownCommand(doc("Get|ting started"), "heading"))).toBe(
      "## Get|ting started",
    );
    expect(show(applyMarkdownCommand(doc("|gi\nbelt|"), "bullet"))).toBe("|- gi\n- belt|");
    expect(show(applyMarkdownCommand(doc("|gi\nbelt|"), "numbered"))).toBe("|1. gi\n2. belt|");
    expect(show(applyMarkdownCommand(doc("|hush|"), "quote"))).toBe("|> hush|");
  });

  it("toggles a list off, and swaps one kind of list for the other", () => {
    expect(show(applyMarkdownCommand(doc("|- gi\n- belt|"), "bullet"))).toBe("|gi\nbelt|");
    expect(show(applyMarkdownCommand(doc("|- gi\n- belt|"), "numbered"))).toBe("|1. gi\n2. belt|");
    // Any heading level comes off, so the button is "heading on / heading off"
    // rather than a level picker nobody asked for.
    expect(show(applyMarkdownCommand(doc("|# Title|"), "heading"))).toBe("|Title|");
  });

  it("skips the blank lines between paragraphs rather than bulleting them", () => {
    expect(show(applyMarkdownCommand(doc("|gi\n\nbelt|"), "bullet"))).toBe("|- gi\n\n- belt|");
  });

  it("does not swallow the next line when the selection ends on a line break", () => {
    expect(show(applyMarkdownCommand(doc("|gi\n|belt"), "bullet"))).toBe("|- gi|\nbelt");
  });

  it("puts the cursor where the person still has to type a link", () => {
    expect(show(applyMarkdownCommand(doc("read the |handbook|"), "link"))).toBe(
      "read the [handbook](|)",
    );
    // A selected address is the address, so the label is what is missing.
    expect(show(applyMarkdownCommand(doc("|https://jitsu.au|"), "link"))).toBe(
      "[|](https://jitsu.au)",
    );
    expect(show(applyMarkdownCommand(doc("see: |"), "link"))).toBe("see: [|]()");
  });
});

describe("wrapWithTypedCharacter", () => {
  it("wraps the selection instead of replacing it", () => {
    // The bug this exists for: highlighting a phrase and reaching for "*"
    // used to delete the phrase.
    expect(show(wrapWithTypedCharacter(doc("keep it |tidy|"), "*")!)).toBe("keep it *|tidy|*");
    expect(show(wrapWithTypedCharacter(doc("keep it |tidy|"), "_")!)).toBe("keep it _|tidy|_");
    expect(show(wrapWithTypedCharacter(doc("|gi|"), "(")!)).toBe("(|gi|)");
  });

  it("nests on a second press, because the selection stays on the inner text", () => {
    const once = wrapWithTypedCharacter(doc("keep it |tidy|"), "*")!;
    expect(show(wrapWithTypedCharacter(once, "*")!)).toBe("keep it **|tidy|**");
  });

  it("is an ordinary keystroke with nothing selected, or with no closing half", () => {
    expect(wrapWithTypedCharacter(doc("tidy|"), "*")).toBeNull();
    expect(wrapWithTypedCharacter(doc("|tidy|"), "a")).toBeNull();
  });
});

describe("continueListOnEnter", () => {
  it("carries the marker onto the next line", () => {
    expect(show(continueListOnEnter(doc("- gi|"))!)).toBe("- gi\n- |");
    expect(show(continueListOnEnter(doc("1. gi|"))!)).toBe("1. gi\n2. |");
    expect(show(continueListOnEnter(doc("  - gi|"))!)).toBe("  - gi\n  - |");
    expect(show(continueListOnEnter(doc("> hush|"))!)).toBe("> hush\n> |");
    expect(show(continueListOnEnter(doc("- [x] gi|"))!)).toBe("- [x] gi\n- [ ] |");
  });

  it("ends the list when the item is empty, rather than adding another", () => {
    expect(show(continueListOnEnter(doc("- gi\n- |"))!)).toBe("- gi\n|");
  });

  it("hands Enter back to the browser everywhere else", () => {
    expect(continueListOnEnter(doc("plain text|"))).toBeNull();
    // A selection to replace is the browser's job, not ours.
    expect(continueListOnEnter(doc("- |gi|"))).toBeNull();
  });
});

describe("markdownShortcut", () => {
  const base = {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
  };

  it("reads the bindings every other editor uses", () => {
    expect(markdownShortcut({ ...base, key: "b", ctrlKey: true })).toBe("bold");
    expect(markdownShortcut({ ...base, key: "I", ctrlKey: true })).toBe("italic");
    expect(markdownShortcut({ ...base, key: "k", ctrlKey: true })).toBe("link");
    expect(markdownShortcut({ ...base, key: "e", ctrlKey: true })).toBe("code");
  });

  it("takes ⌘ on a Mac and leaves Ctrl to the system caret bindings there", () => {
    // Ctrl+B and Ctrl+E move the caret in every text field on macOS.
    expect(markdownShortcut({ ...base, key: "b", metaKey: true }, true)).toBe("bold");
    expect(markdownShortcut({ ...base, key: "b", ctrlKey: true }, true)).toBeNull();
    expect(markdownShortcut({ ...base, key: "b", metaKey: true })).toBeNull();
  });

  it("reads the shifted list bindings off the physical key, not the layout", () => {
    // Shift+8 is "*" on a US keyboard and "(" on a French one.
    expect(
      markdownShortcut({ ...base, key: "*", code: "Digit8", ctrlKey: true, shiftKey: true }),
    ).toBe("bullet");
    expect(
      markdownShortcut({ ...base, key: "&", code: "Digit7", ctrlKey: true, shiftKey: true }),
    ).toBe("numbered");
    expect(
      markdownShortcut({ ...base, key: ">", code: "Period", ctrlKey: true, shiftKey: true }),
    ).toBe("quote");
  });

  it("leaves plain typing and Alt combinations alone", () => {
    expect(markdownShortcut({ ...base, key: "b" })).toBeNull();
    expect(markdownShortcut({ ...base, key: "b", ctrlKey: true, altKey: true })).toBeNull();
    expect(markdownShortcut({ ...base, key: "z", ctrlKey: true })).toBeNull();
  });
});

describe("shortcutLabel", () => {
  it("spells a binding the way the keyboard in front of the person does", () => {
    expect(shortcutLabel("Mod+B", false)).toBe("Ctrl+B");
    expect(shortcutLabel("Mod+B", true)).toBe("⌘B");
    expect(shortcutLabel("Mod+Shift+8", true)).toBe("⌘⇧8");
  });
});

describe("replacementFor", () => {
  it("describes an edit as the smallest range that changed", () => {
    // What lets the browser keep the edit in its own undo history.
    expect(replacementFor("keep it tidy", "keep it **tidy**")).toEqual({
      start: 8,
      end: 12,
      insert: "**tidy**",
    });
    expect(replacementFor("- gi", "gi")).toEqual({ start: 0, end: 2, insert: "" });
    expect(replacementFor("same", "same")).toEqual({ start: 4, end: 4, insert: "" });
  });
});
