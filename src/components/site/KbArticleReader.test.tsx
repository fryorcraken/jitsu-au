import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KbArticleReader } from "./KbArticleReader";
import type { ReaderAnnotation, ReaderArticle, ReaderViewer } from "./KbArticleReader";
import { blockId } from "@/lib/kb";

const BODY = "# House rules\n\nWash your gi.\n\nClip your nails.";

const article: ReaderArticle = {
  slug: "house-rules",
  title: "House rules",
  body_md: BODY,
  version: 3,
  change_note: null,
  updated_at: "2026-07-01T00:00:00Z",
};

const canAnnotate: ReaderViewer = {
  signed_in: true,
  user_id: "u-1",
  is_manager: false,
  can_annotate: true,
};

function annotation(over: Partial<ReaderAnnotation> = {}): ReaderAnnotation {
  return {
    id: "a-1",
    body: "Does this include rash guards?",
    visibility: "shared",
    block_id: blockId("Wash your gi."),
    quote: "Wash your gi.",
    parent_id: null,
    article_version: 3,
    author: "Sam",
    is_mine: false,
    can_edit: false,
    can_resolve: false,
    resolved_at: null,
    created_at: "2026-07-02T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    ...over,
  };
}

function renderReader(over: {
  annotations?: ReaderAnnotation[];
  viewer?: ReaderViewer;
  article?: ReaderArticle;
  onCreate?: (input: unknown) => Promise<boolean>;
}) {
  // The write callbacks report success; the component clears its inputs only
  // when they do. Default to success so the ordinary path is what is exercised.
  const onCreate = over.onCreate ?? vi.fn().mockResolvedValue(true);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(
    <KbArticleReader
      article={over.article ?? article}
      annotations={over.annotations ?? []}
      viewer={over.viewer ?? canAnnotate}
      onCreate={onCreate as never}
      onUpdate={vi.fn().mockResolvedValue(true)}
      onDelete={onDelete}
      onResolve={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return { onCreate, onDelete };
}

describe("KbArticleReader", () => {
  it("renders the article's markdown", () => {
    renderReader({});
    expect(screen.getByRole("heading", { name: "House rules" })).toBeInTheDocument();
    expect(screen.getByText("Wash your gi.")).toBeInTheDocument();
  });

  // Another article links to a section of this one, so the block that opens a
  // section has to carry the id that link aims at.
  it("puts each heading's anchor on the passage that opens it", () => {
    renderReader({
      article: { ...article, body_md: "# House rules\n\nWash your gi.\n\n## Nails {#nails}" },
    });
    expect(document.getElementById("house-rules")?.textContent).toContain("House rules");
    expect(document.getElementById("nails")?.textContent).toContain("Nails");
  });

  it("offers a link to a section, and copies the whole address for pasting", async () => {
    renderReader({});
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const link = screen.getByRole("link", { name: /Link to this section, House rules/i });
    expect(link).toHaveAttribute("href", "#house-rules");
    await userEvent.click(link);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("#house-rules"));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });

  it("offers no section link on a passage that is not a heading", () => {
    renderReader({ article: { ...article, body_md: "Just prose, no headings." } });
    expect(screen.queryByRole("link", { name: /Link to this section/i })).not.toBeInTheDocument();
  });

  it("tells a signed-out reader to sign in rather than showing a composer", () => {
    renderReader({
      viewer: { signed_in: false, user_id: null, is_manager: false, can_annotate: false },
    });
    expect(screen.getByText(/Sign in to leave a comment/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Post comment/i })).not.toBeInTheDocument();
  });

  it("says so when an article has stopped taking comments", () => {
    renderReader({
      viewer: { signed_in: true, user_id: "u-1", is_manager: false, can_annotate: false },
    });
    expect(screen.getByText(/not accepting comments/i)).toBeInTheDocument();
  });

  // The privacy model is the feature. A private note must be labelled wherever
  // it appears, or its author cannot tell what they published.
  it("marks a private note as private", async () => {
    renderReader({
      annotations: [annotation({ visibility: "private", is_mine: true, block_id: null })],
    });
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("posts a comment anchored to the block the reader picked", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderReader({ onCreate });

    // Pick the "Wash your gi." passage, then write about it.
    const picks = screen.getAllByRole("button", { name: /Comment on this passage/i });
    await user.click(picks[1]);
    await user.type(screen.getByPlaceholderText(/Start a comment thread/i), "What about belts?");
    await user.click(screen.getByRole("button", { name: /Post comment/i }));

    expect(onCreate).toHaveBeenCalledWith({
      block_id: blockId("Wash your gi."),
      quote: "Wash your gi.",
      visibility: "shared",
      body: "What about belts?",
    });
  });

  it("posts a private note when the reader picks the private toggle", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderReader({ onCreate });

    await user.click(screen.getByRole("button", { name: /Private note/i }));
    await user.type(screen.getByPlaceholderText(/A note only you will see/i), "Ask about this.");
    await user.click(screen.getByRole("button", { name: /Save note/i }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "private", body: "Ask about this." }),
    );
  });

  // A comment written against wording that has since been edited away is shown
  // apart rather than dropped or silently re-pointed at a different paragraph.
  it("surfaces annotations whose passage no longer exists", () => {
    renderReader({
      annotations: [
        annotation({
          id: "a-orphan",
          block_id: blockId("Wear a mouthguard."),
          quote: "Wear a mouthguard.",
          body: "Is this still required?",
        }),
      ],
    });
    const section = screen.getByText("On earlier wording").closest("div")!;
    expect(within(section).getByText("Is this still required?")).toBeInTheDocument();
  });

  it("hides resolved threads until the reader asks for them", async () => {
    const user = userEvent.setup();
    renderReader({
      annotations: [
        annotation({
          block_id: null,
          quote: null,
          resolved_at: "2026-07-03T00:00:00Z",
          body: "Handled already.",
        }),
      ],
    });
    expect(screen.queryByText("Handled already.")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Show resolved/i));
    expect(screen.getByText("Handled already.")).toBeInTheDocument();
  });

  // The server caps `quote` at 2000 characters. Sending a longer block's full
  // text made it impossible to comment on a long passage at all: the reader
  // wrote their comment and got a raw validation error back.
  it("truncates the quote of a very long passage instead of failing to post", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    const longBlock = "x".repeat(5000);
    renderReader({ article: { ...article, body_md: longBlock }, onCreate });

    await user.click(screen.getAllByRole("button", { name: /Comment on this passage/i })[0]);
    await user.type(screen.getByPlaceholderText(/Start a comment thread/i), "Too long?");
    await user.click(screen.getByRole("button", { name: /Post comment/i }));

    const { quote } = onCreate.mock.calls[0][0] as { quote: string };
    expect(quote).toHaveLength(2000);
  });

  it("keeps what the reader typed when the comment fails to save", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(false);
    renderReader({ onCreate });

    const box = screen.getByPlaceholderText(/Start a comment thread/i);
    await user.type(box, "Worth keeping.");
    await user.click(screen.getByRole("button", { name: /Post comment/i }));

    expect(onCreate).toHaveBeenCalled();
    expect(box).toHaveValue("Worth keeping.");
  });

  it("clears the box once the comment is saved", async () => {
    const user = userEvent.setup();
    renderReader({ onCreate: vi.fn().mockResolvedValue(true) });

    const box = screen.getByPlaceholderText(/Start a comment thread/i);
    await user.type(box, "Posted.");
    await user.click(screen.getByRole("button", { name: /Post comment/i }));

    expect(box).toHaveValue("");
  });

  // On a phone the hover-only gutter marker is hidden, so without this control
  // there is no way to start a comment on a specific passage at all.
  it("offers a way to comment on every passage, not only ones already commented on", () => {
    renderReader({});
    // Scoped to the article body: the composer in the rail has its own
    // "Comment" toggle, which is not what this is about.
    const body = screen.getByRole("article");
    // Three blocks in the fixture, none of them annotated.
    expect(within(body).getAllByRole("button", { name: /^Comment$/i })).toHaveLength(3);
  });

  it("offers no such control to a reader who cannot annotate", () => {
    renderReader({
      viewer: { signed_in: false, user_id: null, is_manager: false, can_annotate: false },
    });
    const body = screen.getByRole("article");
    expect(within(body).queryByRole("button", { name: /^Comment$/i })).not.toBeInTheDocument();
  });

  it("offers a reply on a shared thread", () => {
    renderReader({ annotations: [annotation({ block_id: null, quote: null })] });
    expect(screen.getByRole("button", { name: /Reply/i })).toBeInTheDocument();
  });

  // A private note is not a conversation: there is nobody to reply to, and a
  // reply would have to be shared, which would expose the note it hangs off.
  it("offers no reply on a private note", () => {
    renderReader({
      annotations: [
        annotation({ visibility: "private", is_mine: true, block_id: null, quote: null }),
      ],
    });
    expect(screen.queryByRole("button", { name: /Reply/i })).not.toBeInTheDocument();
  });

  // Deleting a comment takes its replies with it and nothing brings either
  // back, so it asks first, in the app's own dialog rather than the browser's.
  it("says the replies go too before deleting a comment, and deletes only when told to", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderReader({
      annotations: [annotation({ is_mine: true, can_edit: true, block_id: null, quote: null })],
    });

    await user.click(screen.getByRole("button", { name: /Delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete this comment?");
    expect(dialog).toHaveTextContent("Any replies to it go too");
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("a-1"));
  });

  it("keeps a comment when the question is answered no", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderReader({
      annotations: [annotation({ is_mine: true, can_edit: true, block_id: null, quote: null })],
    });

    await user.click(screen.getByRole("button", { name: /Delete/i }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Does this include rash guards?")).toBeInTheDocument();
  });

  // A reply has nothing hanging off it, so it gets its own, shorter question.
  it("asks about a reply on its own terms", async () => {
    const user = userEvent.setup();
    renderReader({
      annotations: [
        annotation({ block_id: null, quote: null }),
        annotation({
          id: "a-2",
          parent_id: "a-1",
          is_mine: true,
          can_edit: true,
          block_id: null,
          quote: null,
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: /Delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete this reply?");
    expect(screen.getByRole("button", { name: "Delete reply" })).toBeInTheDocument();
  });
});
