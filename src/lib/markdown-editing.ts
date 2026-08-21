// What the Markdown body editors do to text when you press a toolbar button, a
// keyboard shortcut, or a character with something selected.
//
// Kept out of the components (the same split `kb-editor.ts` uses, for the same
// reason) because every rule here is about one string and two cursor offsets,
// and that is worth pinning in a unit test rather than through a rendered
// textarea. No React, no DOM.
//
// Every function speaks the same shape: a document in, a document out, where a
// document is the whole text plus where the selection sits. Nothing here
// mutates, focuses, or scrolls anything; `MarkdownEditor` owns that half.

/** The textarea's text and selection, as the editor reads and writes it. */
export type MarkdownDoc = {
  text: string;
  /** Selection start, or the cursor position when `start === end`. */
  start: number;
  end: number;
};

/** A formatting action, shared by the toolbar buttons and the shortcuts. */
export type MarkdownCommand =
  | "bold"
  | "italic"
  | "code"
  | "heading"
  | "bullet"
  | "numbered"
  | "quote"
  | "link";

/**
 * The toolbar, in order, with the shortcut each button also answers to.
 *
 * `shortcut` is written with a `Mod` stand-in rather than "Ctrl" because the
 * same binding is ⌘ on a Mac and Ctrl everywhere else; `shortcutLabel` picks.
 * Heading has no shortcut on purpose: there is no conventional one, and
 * inventing a binding people have to be told about earns less than the button.
 */
export const MARKDOWN_TOOLS: {
  command: MarkdownCommand;
  label: string;
  shortcut: string | null;
}[] = [
  { command: "bold", label: "Bold", shortcut: "Mod+B" },
  { command: "italic", label: "Italic", shortcut: "Mod+I" },
  { command: "code", label: "Code", shortcut: "Mod+E" },
  { command: "heading", label: "Heading", shortcut: null },
  { command: "bullet", label: "Bullet list", shortcut: "Mod+Shift+8" },
  { command: "numbered", label: "Numbered list", shortcut: "Mod+Shift+7" },
  { command: "quote", label: "Quote", shortcut: "Mod+Shift+." },
  { command: "link", label: "Link", shortcut: "Mod+K" },
];

/** "Mod+B" as the person's own keyboard writes it. */
export function shortcutLabel(shortcut: string, apple: boolean): string {
  return apple
    ? shortcut.replace("Mod+", "⌘").replace("Shift+", "⇧")
    : shortcut.replace("Mod", "Ctrl");
}

/**
 * Which command a key press means, or null to let the browser have the key.
 *
 * `apple` decides which modifier counts, and it is not cosmetic: on a Mac,
 * Ctrl+B and Ctrl+E move the caret in every text field on the system, so
 * claiming them there would break something a person already relies on. ⌘ is
 * the editing modifier on that keyboard and Ctrl is the editing modifier on
 * every other one.
 *
 * The list-and-quote bindings are matched on `code` rather than `key`: the
 * character a shifted 7 produces depends on the keyboard layout ("&" on a US
 * one, "/" on a French one), while the physical key does not.
 */
export function markdownShortcut(
  e: {
    key: string;
    code?: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  apple = false,
): MarkdownCommand | null {
  const mod = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  if (e.shiftKey) {
    if (e.code === "Digit8") return "bullet";
    if (e.code === "Digit7") return "numbered";
    if (e.code === "Period") return "quote";
    return null;
  }
  switch (e.key.toLowerCase()) {
    case "b":
      return "bold";
    case "i":
      return "italic";
    case "e":
      return "code";
    case "k":
      return "link";
    default:
      return null;
  }
}

const WORD = /[\p{L}\p{N}_]/u;

/** The word the cursor is sitting in or against, so a shortcut pressed with
 * nothing selected still has something to act on. Empty range when it is not
 * touching a word. */
function wordRangeAt(text: string, at: number): [number, number] {
  let start = at;
  let end = at;
  while (start > 0 && WORD.test(text[start - 1])) start--;
  while (end < text.length && WORD.test(text[end])) end++;
  return [start, end];
}

/** Wrap, or unwrap, the selection in an inline marker (`**`, `_`, `` ` ``). */
function toggleInline(doc: MarkdownDoc, marker: string): MarkdownDoc {
  const { text } = doc;
  let [start, end] = doc.start === doc.end ? wordRangeAt(text, doc.start) : [doc.start, doc.end];

  // Whitespace inside the markers stops Markdown seeing them at all
  // ("** bold **" renders literally), and picking a word by double-clicking
  // often takes the space after it. Leave it outside.
  while (end > start && /\s/.test(text[end - 1])) end--;
  while (start < end && /\s/.test(text[start])) start++;

  const selected = text.slice(start, end);
  const m = marker.length;

  // Already wrapped, with the markers just outside the selection.
  if (text.slice(start - m, start) === marker && text.slice(end, end + m) === marker) {
    return {
      text: text.slice(0, start - m) + selected + text.slice(end + m),
      start: start - m,
      end: end - m,
    };
  }
  // Already wrapped, with the markers inside the selection.
  if (selected.length >= m * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(m, -m);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      start,
      end: start + inner.length,
    };
  }
  return {
    text: `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}`,
    start: start + m,
    end: end + m,
  };
}

type LineRule = {
  /** Matches the prefix this command adds, so pressing it again removes it. */
  match: RegExp;
  /** Also stripped before adding, so bullet-over-numbered swaps rather than stacks. */
  clear: RegExp;
  make: (index: number) => string;
};

const LINE_RULES: Record<"heading" | "bullet" | "numbered" | "quote", LineRule> = {
  heading: { match: /^#{1,6} /, clear: /^#{1,6} /, make: () => "## " },
  bullet: { match: /^[-*+] /, clear: /^([-*+] |\d+\. )/, make: () => "- " },
  numbered: { match: /^\d+\. /, clear: /^([-*+] |\d+\. )/, make: (i) => `${i + 1}. ` },
  quote: { match: /^> /, clear: /^> /, make: () => "> " },
};

/** Add (or remove) a line marker on every line the selection touches, so a
 * selected block becomes one bullet per line rather than one bullet swallowing
 * the lot. */
function toggleLines(doc: MarkdownDoc, kind: keyof typeof LINE_RULES): MarkdownDoc {
  const rule = LINE_RULES[kind];
  const { text } = doc;
  const lineStart = text.lastIndexOf("\n", doc.start - 1) + 1;
  // A selection dragged to the start of the next line ends on a newline; that
  // next line is not part of what the person highlighted.
  const scanFrom = doc.end > doc.start && text[doc.end - 1] === "\n" ? doc.end - 1 : doc.end;
  const nextBreak = text.indexOf("\n", scanFrom);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;

  const lines = text.slice(lineStart, lineEnd).split("\n");
  const written = lines.filter((line) => line.trim() !== "");
  const on = written.length > 0 && written.every((line) => rule.match.test(line));

  let counter = 0;
  const next = lines.map((line) => {
    if (on) return line.replace(rule.match, "");
    // Blank lines between paragraphs are not list items; prefixing them leaves
    // a trail of empty bullets through the block.
    if (line.trim() === "" && lines.length > 1) return line;
    return rule.make(counter++) + line.replace(rule.clear, "");
  });

  const block = next.join("\n");
  const collapsed = doc.start === doc.end;
  const shift = next[0].length - lines[0].length;
  return {
    text: text.slice(0, lineStart) + block + text.slice(lineEnd),
    start: collapsed ? Math.max(lineStart, doc.start + shift) : lineStart,
    end: collapsed ? Math.max(lineStart, doc.start + shift) : lineStart + block.length,
  };
}

const URL_LIKE = /^(https?:\/\/|mailto:|\/)\S*$/;

/** `[label](url)`, with the cursor left wherever the person still has to type. */
function insertLink(doc: MarkdownDoc): MarkdownDoc {
  const { text } = doc;
  const [start, end] = doc.start === doc.end ? wordRangeAt(text, doc.start) : [doc.start, doc.end];
  const selected = text.slice(start, end);

  // A selected address is the address, not the words to show. Leave the label
  // empty and put the cursor there.
  if (URL_LIKE.test(selected)) {
    return {
      text: `${text.slice(0, start)}[](${selected})${text.slice(end)}`,
      start: start + 1,
      end: start + 1,
    };
  }
  const at = start + selected.length + 3;
  return {
    text: `${text.slice(0, start)}[${selected}]()${text.slice(end)}`,
    // Nothing selected and no word to grab: the label is what is missing.
    start: selected ? at : start + 1,
    end: selected ? at : start + 1,
  };
}

/** Run a toolbar button or its shortcut against the document. */
export function applyMarkdownCommand(doc: MarkdownDoc, command: MarkdownCommand): MarkdownDoc {
  switch (command) {
    case "bold":
      return toggleInline(doc, "**");
    case "italic":
      return toggleInline(doc, "_");
    case "code":
      return toggleInline(doc, "`");
    case "link":
      return insertLink(doc);
    default:
      return toggleLines(doc, command);
  }
}

/** Characters that wrap a selection instead of replacing it, and what closes
 * them. Typing over a selection is normally destructive, which is exactly what
 * you do NOT want when you have just highlighted a phrase and reached for `*`. */
const PAIRS: Record<string, string> = {
  "*": "*",
  _: "_",
  "`": "`",
  "~": "~",
  '"': '"',
  "'": "'",
  "(": ")",
  "[": "]",
  "{": "}",
};

/**
 * Wrap the selection in the character just typed, keeping the selection on the
 * inner text so a second press nests (`*word*` then `**word**`).
 *
 * Null means "this is an ordinary keystroke": nothing selected, or a character
 * that has no closing half.
 */
export function wrapWithTypedCharacter(doc: MarkdownDoc, char: string): MarkdownDoc | null {
  const close = PAIRS[char];
  if (!close || doc.start === doc.end) return null;
  const selected = doc.text.slice(doc.start, doc.end);
  return {
    text: `${doc.text.slice(0, doc.start)}${char}${selected}${close}${doc.text.slice(doc.end)}`,
    start: doc.start + 1,
    end: doc.end + 1,
  };
}

const LIST_LINE = /^(\s*)(?:([-*+])|(\d+)\.|(>)) (?:(\[[ xX]\]) )?(.*)$/;

/**
 * What Enter should do inside a list or a quote: carry the marker onto the next
 * line, and on a marker with nothing typed after it, take the marker away
 * instead (which is how every editor lets you leave a list).
 *
 * Null hands the key back to the browser, which keeps the native newline and
 * its place in the undo history for the common case.
 */
export function continueListOnEnter(doc: MarkdownDoc): MarkdownDoc | null {
  if (doc.start !== doc.end) return null;
  const { text, start } = doc;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const match = LIST_LINE.exec(text.slice(lineStart, start));
  if (!match) return null;

  const [, indent, bullet, number, quote, task, content] = match;
  if (content.trim() === "" && !task) {
    // An empty item: end the list rather than adding another empty one.
    return { text: text.slice(0, lineStart) + text.slice(start), start: lineStart, end: lineStart };
  }
  const marker = quote ? "> " : bullet ? `${bullet} ` : `${Number(number) + 1}. `;
  const insert = `\n${indent}${marker}${task ? "[ ] " : ""}`;
  return {
    text: text.slice(0, start) + insert + text.slice(start),
    start: start + insert.length,
    end: start + insert.length,
  };
}

/**
 * The smallest single replacement that turns one text into the other.
 *
 * The editor applies its edits as a replacement over a range rather than by
 * swapping the whole value, because that is what lets the browser keep them in
 * its own undo history: Ctrl+Z after pressing Bold takes the bold off, instead
 * of doing nothing (or worse, undoing the last ten minutes of typing in one go).
 */
export function replacementFor(
  before: string,
  after: string,
): { start: number; end: number; insert: string } {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    start: prefix,
    end: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
