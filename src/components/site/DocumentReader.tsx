// The reading + annotating surface for a club document.
//
// The document is rendered one BLOCK at a time (`splitBlocks`) rather than as
// one markdown blob, because a block is the unit an annotation hangs off: the
// same split runs on the server when a comment is stored, so the anchor a reader
// sees and the anchor that is saved are computed by the same code.
//
// Presentation only. Every rule about who may do what has already been decided
// server-side and arrives as `can_edit` / `can_resolve` / `can_annotate` flags —
// this component never re-derives permissions, so there is one place to get them
// wrong instead of two.
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Lock, MessageSquare, Check, Trash2, Pencil, CornerDownRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/dates";
import { groupThreads, resolveAnchors, splitBlocks } from "@/lib/documents";
import type { AnnotationVisibility } from "@/lib/documents";

/** One annotation, exactly as `listAnnotations` returns it. */
export type ReaderAnnotation = {
  id: string;
  body: string;
  visibility: AnnotationVisibility;
  block_id: string | null;
  quote: string | null;
  parent_id: string | null;
  document_version: number;
  author: string | null;
  author_user_id: string;
  is_mine: boolean;
  can_edit: boolean;
  can_resolve: boolean;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ReaderDocument = {
  slug: string;
  title: string;
  body_md: string;
  version: number;
  change_note: string | null;
  updated_at: string;
};

export type ReaderViewer = {
  signed_in: boolean;
  user_id: string | null;
  is_manager: boolean;
  can_annotate: boolean;
};

export type NewAnnotation = {
  block_id: string | null;
  quote: string | null;
  visibility: AnnotationVisibility;
  body: string;
  parent_id?: string;
};

type Props = {
  document: ReaderDocument;
  annotations: ReaderAnnotation[];
  viewer: ReaderViewer;
  busy?: boolean;
  onCreate: (input: NewAnnotation) => Promise<void>;
  onUpdate: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
};

export function DocumentReader({
  document,
  annotations,
  viewer,
  busy,
  onCreate,
  onUpdate,
  onDelete,
  onResolve,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const blocks = useMemo(() => splitBlocks(document.body_md), [document.body_md]);
  const resolved = useMemo(() => resolveAnchors(blocks, annotations), [blocks, annotations]);

  const visible = (list: ReaderAnnotation[]) =>
    showResolved ? list : list.filter((a) => !a.resolved_at);

  const selectedBlock = blocks.find((b) => b.id === selected) ?? null;
  const selectedAnnotations = selected ? (resolved.anchored.get(selected) ?? []) : [];

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <article className="space-y-1">
        {blocks.map((block) => {
          const onBlock = visible(resolved.anchored.get(block.id) ?? []);
          const shared = onBlock.filter((a) => a.visibility === "shared" && !a.parent_id).length;
          const notes = onBlock.filter((a) => a.visibility === "private").length;
          const isSelected = block.id === selected;
          return (
            <div
              key={block.id}
              className={cn(
                "group relative rounded-md border border-transparent px-3 py-1 transition-colors",
                isSelected ? "border-primary/40 bg-muted/60" : "hover:bg-muted/40",
              )}
            >
              <button
                type="button"
                aria-label={`Comment on this passage${shared + notes ? `, ${shared + notes} existing` : ""}`}
                aria-pressed={isSelected}
                onClick={() => setSelected(isSelected ? null : block.id)}
                className="absolute -left-1 top-2 -translate-x-full pr-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 aria-pressed:opacity-100 max-lg:hidden"
              >
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
              </button>

              <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-bold prose-headings:text-foreground prose-p:leading-relaxed prose-strong:text-foreground">
                <ReactMarkdown>{block.markdown}</ReactMarkdown>
              </div>

              {(shared > 0 || notes > 0) && (
                <button
                  type="button"
                  onClick={() => setSelected(isSelected ? null : block.id)}
                  className="mt-1 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  {shared > 0 && (
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {shared}
                    </span>
                  )}
                  {notes > 0 && (
                    <span className="flex items-center gap-1">
                      <Lock className="h-3 w-3" />
                      {notes}
                    </span>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </article>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {selectedBlock ? "This passage" : "Comments and notes"}
          </h2>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show resolved
          </label>
        </div>

        {selectedBlock ? (
          <div className="space-y-4 rounded-lg border p-4">
            <blockquote className="border-l-2 pl-3 text-xs italic text-muted-foreground">
              {truncate(selectedBlock.markdown, 160)}
            </blockquote>
            <ThreadList
              annotations={visible(selectedAnnotations)}
              busy={busy}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onResolve={onResolve}
              onReply={(parentId, body) =>
                onCreate({
                  block_id: selectedBlock.id,
                  quote: selectedBlock.markdown,
                  visibility: "shared",
                  body,
                  parent_id: parentId,
                })
              }
            />
            {viewer.can_annotate ? (
              <Composer
                busy={busy}
                onSubmit={(body, visibility) =>
                  onCreate({
                    block_id: selectedBlock.id,
                    quote: selectedBlock.markdown,
                    visibility,
                    body,
                  })
                }
              />
            ) : (
              <CannotAnnotate viewer={viewer} />
            )}
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4 rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">
              Pick a paragraph to comment on it, or leave a note about the document as a whole.
            </p>
            <ThreadList
              annotations={visible(resolved.document)}
              busy={busy}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onResolve={onResolve}
              onReply={(parentId, body) =>
                onCreate({
                  block_id: null,
                  quote: null,
                  visibility: "shared",
                  body,
                  parent_id: parentId,
                })
              }
            />
            {viewer.can_annotate ? (
              <Composer
                busy={busy}
                onSubmit={(body, visibility) =>
                  onCreate({ block_id: null, quote: null, visibility, body })
                }
              />
            ) : (
              <CannotAnnotate viewer={viewer} />
            )}
          </div>
        )}

        {/* Comments whose passage has since been edited away. Shown rather than
            dropped: a comment on a clause that was rewritten is usually the most
            interesting one on the page. */}
        {visible(resolved.orphaned).length > 0 && (
          <div className="space-y-3 rounded-lg border border-dashed p-4">
            <h3 className="text-sm font-semibold">On earlier wording</h3>
            <p className="text-xs text-muted-foreground">
              The passages these were written about have changed since.
            </p>
            {visible(resolved.orphaned).map((a) => (
              <div key={a.id} className="space-y-1">
                {a.quote && (
                  <blockquote className="border-l-2 pl-3 text-xs italic text-muted-foreground line-through">
                    {truncate(a.quote, 120)}
                  </blockquote>
                )}
                <AnnotationCard
                  annotation={a}
                  busy={busy}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                  onResolve={onResolve}
                />
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

function CannotAnnotate({ viewer }: { viewer: ReaderViewer }) {
  return (
    <p className="text-xs text-muted-foreground">
      {viewer.signed_in
        ? "This document is not accepting comments."
        : "Sign in to leave a comment or a private note."}
    </p>
  );
}

function ThreadList({
  annotations,
  busy,
  onUpdate,
  onDelete,
  onResolve,
  onReply,
}: {
  annotations: ReaderAnnotation[];
  busy?: boolean;
  onUpdate: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onReply: (parentId: string, body: string) => Promise<void>;
}) {
  const threads = useMemo(() => groupThreads(annotations), [annotations]);
  if (!threads.length) {
    return <p className="text-xs text-muted-foreground">Nothing here yet.</p>;
  }
  return (
    <div className="space-y-4">
      {threads.map(({ root, replies }) => (
        <Thread
          key={root.id}
          root={root}
          replies={replies}
          busy={busy}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onResolve={onResolve}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

function Thread({
  root,
  replies,
  busy,
  onUpdate,
  onDelete,
  onResolve,
  onReply,
}: {
  root: ReaderAnnotation;
  replies: ReaderAnnotation[];
  busy?: boolean;
  onUpdate: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onReply: (parentId: string, body: string) => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");

  return (
    <div className={cn("space-y-2", root.resolved_at && "opacity-60")}>
      <AnnotationCard
        annotation={root}
        busy={busy}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onResolve={onResolve}
      />
      {replies.map((reply) => (
        <div key={reply.id} className="ml-4 border-l pl-3">
          <AnnotationCard
            annotation={reply}
            busy={busy}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onResolve={onResolve}
          />
        </div>
      ))}
      {/* Only shared threads take replies — a private note is not a conversation. */}
      {root.visibility === "shared" && !root.resolved_at && (
        <div className="ml-4">
          {replying ? (
            <div className="space-y-2">
              <Textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                rows={2}
                maxLength={5000}
                placeholder="Reply..."
                className="text-sm"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !replyBody.trim()}
                  onClick={async () => {
                    await onReply(root.id, replyBody.trim());
                    setReplyBody("");
                    setReplying(false);
                  }}
                >
                  Reply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setReplying(true)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <CornerDownRight className="h-3 w-3" />
              Reply
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AnnotationCard({
  annotation,
  busy,
  onUpdate,
  onDelete,
  onResolve,
}: {
  annotation: ReaderAnnotation;
  busy?: boolean;
  onUpdate: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(annotation.body);

  return (
    <div className="rounded-md bg-muted/50 p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {annotation.is_mine ? "You" : (annotation.author ?? "Someone at the club")}
        </span>
        {annotation.visibility === "private" && (
          <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px]">
            <Lock className="h-2.5 w-2.5" />
            Private
          </Badge>
        )}
        {annotation.resolved_at && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            Resolved
          </Badge>
        )}
        <span>{formatDate(annotation.created_at)}</span>
        {/* Which wording this was written against. Only worth saying when it is
            not the version on screen, which the parent decides by passing the
            annotation through unchanged. */}
        <span>v{annotation.document_version}</span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={5000}
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !draft.trim()}
              onClick={async () => {
                await onUpdate(annotation.id, draft.trim());
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(annotation.body);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap">{annotation.body}</p>
      )}

      {!editing && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {annotation.can_edit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          )}
          {annotation.can_edit && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // Replies cascade with their root, so a thread's author deleting
                // it takes the conversation. Ask first.
                const warning = annotation.parent_id
                  ? "Delete this reply?"
                  : "Delete this comment and any replies to it?";
                if (window.confirm(warning)) void onDelete(annotation.id);
              }}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          )}
          {annotation.can_resolve && !annotation.parent_id && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onResolve(annotation.id, !annotation.resolved_at)}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <Check className="h-3 w-3" />
              {annotation.resolved_at ? "Reopen" : "Resolve"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Composer({
  busy,
  onSubmit,
}: {
  busy?: boolean;
  onSubmit: (body: string, visibility: AnnotationVisibility) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<AnnotationVisibility>("shared");

  return (
    <div className="space-y-2 border-t pt-3">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={5000}
        placeholder={
          visibility === "private" ? "A note only you will see..." : "Start a comment thread..."
        }
        className="text-sm"
      />
      {/* The privacy choice is made BEFORE writing, and the placeholder changes
          with it, so nobody types a private thought into a public box. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setVisibility("shared")}
            className={cn(
              "rounded px-2 py-1",
              visibility === "shared"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground",
            )}
          >
            Comment
          </button>
          <button
            type="button"
            onClick={() => setVisibility("private")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1",
              visibility === "private"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground",
            )}
          >
            <Lock className="h-3 w-3" />
            Private note
          </button>
        </div>
        <Button
          size="sm"
          disabled={busy || !body.trim()}
          onClick={async () => {
            await onSubmit(body.trim(), visibility);
            setBody("");
          }}
        >
          {visibility === "private" ? "Save note" : "Post comment"}
        </Button>
      </div>
    </div>
  );
}

/** First `max` characters of a block, for quoting it back in the rail. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
