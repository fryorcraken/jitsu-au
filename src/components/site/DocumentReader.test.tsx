import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentReader } from "./DocumentReader";
import type { ReaderAnnotation, ReaderDocument, ReaderViewer } from "./DocumentReader";
import { blockId } from "@/lib/documents";

const BODY = "# House rules\n\nWash your gi.\n\nClip your nails.";

const document: ReaderDocument = {
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
    document_version: 3,
    author: "Sam",
    author_user_id: "u-2",
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
  onCreate?: (input: unknown) => Promise<void>;
}) {
  const onCreate = over.onCreate ?? vi.fn().mockResolvedValue(undefined);
  render(
    <DocumentReader
      document={document}
      annotations={over.annotations ?? []}
      viewer={over.viewer ?? canAnnotate}
      onCreate={onCreate as never}
      onUpdate={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onResolve={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return { onCreate };
}

describe("DocumentReader", () => {
  it("renders the document's markdown", () => {
    renderReader({});
    expect(screen.getByRole("heading", { name: "House rules" })).toBeInTheDocument();
    expect(screen.getByText("Wash your gi.")).toBeInTheDocument();
  });

  it("tells a signed-out reader to sign in rather than showing a composer", () => {
    renderReader({
      viewer: { signed_in: false, user_id: null, is_manager: false, can_annotate: false },
    });
    expect(screen.getByText(/Sign in to leave a comment/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Post comment/i })).not.toBeInTheDocument();
  });

  it("says so when a document has stopped taking comments", () => {
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
});
