// The Markdown body textarea used by the manager editors, with the formatting
// toolbar and the keyboard shortcuts that go with it.
//
// A manager writing an article is not thinking about Markdown syntax, they are
// thinking about a sentence they want emphasised. So the two ways they will
// reach for it both work: the buttons, and the shortcuts every other editor on
// their laptop already answers to (Ctrl/⌘ + B, I, K). Selecting a phrase and
// typing "*" wraps it rather than deleting it, which is what that keystroke
// means everywhere else and, before this, silently threw the phrase away.
//
// The text rules themselves live in `@/lib/markdown-editing` and are tested
// there; this file is the part that needs a DOM: focus, selection, and undo.
import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Bold, Code, Heading2, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  MARKDOWN_TOOLS,
  applyMarkdownCommand,
  continueListOnEnter,
  markdownShortcut,
  replacementFor,
  shortcutLabel,
  wrapWithTypedCharacter,
  type MarkdownCommand,
  type MarkdownDoc,
} from "@/lib/markdown-editing";

const ICONS: Record<MarkdownCommand, typeof Bold> = {
  bold: Bold,
  italic: Italic,
  code: Code,
  heading: Heading2,
  bullet: List,
  numbered: ListOrdered,
  quote: Quote,
  link: Link2,
};

/** Whether to spell the shortcuts with ⌘ or with Ctrl. Read at render rather
 * than kept in state: these screens are client-rendered (`ssr: false`), so
 * there is no server pass to disagree with. */
function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export function MarkdownEditor({
  id,
  value,
  onChange,
  rows = 22,
  textareaRef,
  tools,
  "aria-describedby": describedBy,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  /** For a caller that also inserts text of its own (the blog composer's image
   * and video buttons need to know where the cursor is). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Extra buttons for this editor only, added after the formatting ones. */
  tools?: ReactNode;
  "aria-describedby"?: string;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  const apple = isApple();

  /**
   * Write an edit back through the browser's own editing machinery where it
   * will take it, so the change joins the undo stack instead of clearing it.
   * Setting the value straight from React works, but Ctrl+Z afterwards either
   * does nothing or jumps back further than anyone meant.
   */
  function apply(next: MarkdownDoc | null) {
    const el = ref.current;
    if (!el || !next) return;
    const patch = replacementFor(value, next.text);
    el.focus();
    el.setSelectionRange(patch.start, patch.end);
    let handled = false;
    try {
      handled = document.execCommand(patch.insert ? "insertText" : "delete", false, patch.insert);
    } catch {
      handled = false;
    }
    // `execCommand` is missing under the test runner and can be refused by a
    // browser, so never trust its answer: check what the textarea actually
    // holds. The fallback writes the value straight onto the element as well as
    // through `onChange`, because React's re-render is a tick away and the next
    // keystroke of a fast typist would otherwise land at the old caret.
    if (!handled || el.value !== next.text) {
      el.value = next.text;
      onChange(next.text);
    }
    el.setSelectionRange(next.start, next.end);
  }

  function docFrom(el: HTMLTextAreaElement): MarkdownDoc {
    return { text: value, start: el.selectionStart, end: el.selectionEnd };
  }

  function runCommand(command: MarkdownCommand) {
    const el = ref.current;
    if (!el) return;
    apply(applyMarkdownCommand(docFrom(el), command));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    const doc = docFrom(e.currentTarget);

    const command = markdownShortcut(e, apple);
    if (command) {
      // Several of these are browser bindings (⌘K is the address bar). Taking
      // the key is the point: the person is typing in a text box.
      e.preventDefault();
      runCommand(command);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "Enter" && !e.shiftKey) {
      const next = continueListOnEnter(doc);
      if (next) {
        e.preventDefault();
        apply(next);
      }
      return;
    }
    if (e.key.length === 1) {
      const next = wrapWithTypedCharacter(doc, e.key);
      if (next) {
        e.preventDefault();
        apply(next);
      }
    }
  }

  return (
    <div>
      <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="Formatting">
        {MARKDOWN_TOOLS.map(({ command, label, shortcut }) => {
          const Icon = ICONS[command];
          const hint = shortcut ? `${label} (${shortcutLabel(shortcut, apple)})` : label;
          return (
            <Button
              key={command}
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label={hint}
              title={hint}
              // Keeps the caret in the textarea: without this the click blurs
              // it first, and on some browsers the selection goes with it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runCommand(command)}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </Button>
          );
        })}
        {tools}
      </div>
      <Textarea
        id={id}
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={rows}
        aria-describedby={describedBy}
        className="mt-2 font-mono text-sm"
      />
    </div>
  );
}
