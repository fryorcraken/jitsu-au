import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownEditor } from "@/components/site/MarkdownEditor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uploadBlogImage } from "@/lib/blog.functions";
import { deriveExcerpt, extractYouTubeId, splitBlogContent } from "@/lib/blog-content";
import { blogMarkdownComponents } from "@/lib/blog-markdown";
import { BlogVideoBlock } from "@/components/site/BlogVideoBlock";
import { defaultBlogSlug, slugify } from "@/lib/slug";
import {
  blogImageMimeTypes,
  blogPostSchema,
  type BlogImageMimeType,
  type BlogPostStatus,
} from "@/lib/validation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useEditorDraft } from "@/hooks/use-editor-draft";
import { DraftRestoreBanner } from "@/components/site/DraftRestoreBanner";
import { SaveFailure } from "@/components/site/SaveFailure";

/** File -> base64, same chunked approach as the paper-waiver scan upload
 * (`manager.waivers_.upload.tsx`), which avoids a giant intermediate string
 * from `String.fromCharCode(...bytes)` on a large file. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const IMAGE_ACCEPT = blogImageMimeTypes.join(",");

function isBlogImageMimeType(type: string): type is BlogImageMimeType {
  return (blogImageMimeTypes as readonly string[]).includes(type);
}

/**
 * The draft's own flat shape, and the empty value of each field.
 *
 * Separate from `BlogPostEditorValue` on purpose: a draft has to survive being
 * written by an older build of the site, so every field is a plain string or
 * boolean with an obvious empty value (`cover_image_url`'s `null` becomes `""`).
 * See `reviveDraftFields`.
 */
type BlogDraftFields = {
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  status: string;
  coverPath: string;
  coverUrl: string;
};

const BLOG_DRAFT_SHAPE: BlogDraftFields = {
  title: "",
  slug: "",
  excerpt: "",
  body: "",
  status: "draft",
  coverPath: "",
  coverUrl: "",
};

export type BlogPostEditorValue = {
  title: string;
  slug: string;
  excerpt: string;
  body_md: string;
  cover_image_path: string;
  cover_image_url: string | null;
  status: BlogPostStatus;
};

/**
 * The manager post composer: title/slug/excerpt fields, a Markdown body with a
 * formatting toolbar and image/video insert, a status picker, and a live
 * preview — same textarea-plus-`ReactMarkdown`-preview shape as the waiver
 * template editor (`manager.waiver-template.tsx`), extended with the image
 * upload and `[[video:<url>]]` embed convention this feature adds.
 */
export function BlogPostEditor({
  postId,
  initial,
  saving,
  onSave,
  onDirtyChange,
}: {
  /** Undefined while composing a brand-new post: images upload under `drafts/`. */
  postId?: string;
  initial: BlogPostEditorValue;
  saving: boolean;
  /**
   * Save it.
   *
   * Resolve `true` only when it really landed: that is the signal to throw away
   * the on-device draft, and doing it on a failed save would delete the copy
   * that is about to be needed. Resolve `false`, or a message to show, when it
   * did not — the editor keeps that on screen (`SaveFailure`) instead of
   * leaving it to a toast that fades.
   */
  onSave: (value: BlogPostEditorValue) => Promise<boolean | string>;
  /** Called whenever the form's dirty-vs-`initial` state changes, so the
   * parent route can guard navigating away. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState(initial.slug);
  const [excerpt, setExcerpt] = useState(initial.excerpt);
  const [body, setBody] = useState(initial.body_md);
  const [status, setStatus] = useState<BlogPostStatus>(initial.status);
  const [coverPath, setCoverPath] = useState(initial.cover_image_path);
  const [coverUrl, setCoverUrl] = useState(initial.cover_image_url);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [mobileTab, setMobileTab] = useState<"write" | "preview">("write");
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  /**
   * The last failed save, kept on screen rather than left to a toast.
   *
   * Cleared when a save is attempted and when anything is edited: a stale
   * "not saved" panel over a form somebody has since fixed and saved is its own
   * kind of wrong answer.
   */
  const [saveError, setSaveError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const upload = useServerFn(uploadBlogImage);
  const { user } = useAuth();

  // Re-seed the form whenever the parent hands us a new baseline — e.g. the
  // edit page updates `initial` after a successful save, so the "unsaved
  // changes" comparison below resets rather than staying dirty forever.
  useEffect(() => {
    setTitle(initial.title);
    setSlug(initial.slug);
    setExcerpt(initial.excerpt);
    setBody(initial.body_md);
    setStatus(initial.status);
    setCoverPath(initial.cover_image_path);
    setCoverUrl(initial.cover_image_url);
  }, [initial]);

  const dirty =
    title !== initial.title ||
    slug !== initial.slug ||
    excerpt !== initial.excerpt ||
    body !== initial.body_md ||
    status !== initial.status ||
    coverPath !== initial.cover_image_path;

  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // Editing anything clears the last failure: the panel is about the save that
  // was attempted, and leaving it up over changed text claims something about
  // work it never saw.
  useEffect(() => {
    setSaveError(null);
  }, [title, slug, excerpt, body, status, coverPath]);

  // Covers a closed tab / refresh / typed-in address bar on a DESKTOP browser.
  // In-app navigation (clicking another sidebar link) is guarded separately by
  // the parent route's "Back to posts" action, which checks `dirty` before
  // navigating. On a phone this fires for essentially nothing — iOS ignores it,
  // and an installed app the system reclaims in the background is never asked to
  // unload — which is why the real safety net is the draft below, not this.
  useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // The safety net. Everything typed here is kept on this device as it is
  // written and flushed the moment the page is hidden, so leaving the app and
  // coming back to a relaunched, empty editor no longer costs the post. See
  // `src/lib/editor-draft.ts` for why this is localStorage where the waiver's
  // equivalent is sessionStorage.
  const draftFields = useMemo<BlogDraftFields>(
    () => ({ title, slug, excerpt, body, status, coverPath, coverUrl: coverUrl ?? "" }),
    [title, slug, excerpt, body, status, coverPath, coverUrl],
  );
  const draftBaseline = useMemo<BlogDraftFields>(
    () => ({
      title: initial.title,
      slug: initial.slug,
      excerpt: initial.excerpt,
      body: initial.body_md,
      status: initial.status,
      coverPath: initial.cover_image_path,
      coverUrl: initial.cover_image_url ?? "",
    }),
    [initial],
  );
  const draft = useEditorDraft<BlogDraftFields>({
    kind: "blog-post",
    scope: postId ?? "new",
    owner: user?.id ?? null,
    value: draftFields,
    baseline: draftBaseline,
    shape: BLOG_DRAFT_SHAPE,
  });

  function restoreDraft() {
    const stored = draft.offered;
    if (!stored) return;
    setTitle(stored.title);
    setSlug(stored.slug);
    setExcerpt(stored.excerpt);
    setBody(stored.body);
    setStatus(stored.status === "published" ? "published" : "draft");
    setCoverPath(stored.coverPath);
    setCoverUrl(stored.coverUrl || null);
    draft.restore();
  }

  const willUnpublish = initial.status === "published" && status === "draft";

  async function uploadFile(file: File): Promise<{ path: string; url: string } | null> {
    if (!isBlogImageMimeType(file.type)) {
      toast.error("That file type isn't supported. Use PNG, JPEG, WebP or GIF.");
      return null;
    }
    const data = await fileToBase64(file);
    return upload({ data: { post_id: postId, name: file.name, type: file.type, data } });
  }

  async function handleInsertImage(file: File) {
    // Capture where to insert BEFORE the upload starts: the upload can take
    // several seconds, and using the selection/body captured at click time
    // (rather than whatever is current when the upload resolves) means text
    // typed in the meantime is neither lost nor split by the insert landing
    // in the wrong place.
    const insertPos = bodyRef.current?.selectionStart ?? body.length;
    setUploadingImage(true);
    try {
      const res = await uploadFile(file);
      if (res) {
        const markdown = `\n![${file.name}](${res.url})\n`;
        setBody((prev) => `${prev.slice(0, insertPos)}${markdown}${prev.slice(insertPos)}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not upload that image");
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleCoverImage(file: File) {
    setUploadingCover(true);
    try {
      const res = await uploadFile(file);
      if (res) {
        setCoverPath(res.path);
        setCoverUrl(res.url);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not upload that image");
    } finally {
      setUploadingCover(false);
    }
  }

  function confirmInsertVideo() {
    const url = videoUrl.trim();
    if (!url) return;
    const insertPos = bodyRef.current?.selectionStart ?? body.length;
    setBody((prev) => `${prev.slice(0, insertPos)}\n[[video:${url}]]\n${prev.slice(insertPos)}`);
    setVideoDialogOpen(false);
  }

  function handleSave() {
    const value: BlogPostEditorValue = {
      title: title.trim(),
      slug: slug.trim(),
      excerpt: excerpt.trim(),
      body_md: body.trim(),
      cover_image_path: coverPath,
      cover_image_url: coverUrl,
      status,
    };
    const check = blogPostSchema.safeParse(value);
    if (!check.success) {
      toast.error(check.error.issues[0]?.message ?? "Check the form for errors.");
      return;
    }
    // Deliberately no confirm here. Taking a post off the blog is undone by
    // publishing it again from this same form, and the notice under the status
    // picker already says what saving will do, before the click rather than
    // after it. A modal on top of that is friction on a reversible action.
    //
    // The draft is cleared only once the save has actually landed. The edit page
    // also moves its baseline to match, which clears it a second time; the new
    // post page navigates away instead, and without this its draft would be
    // offered back the next time somebody opened "New post".
    setSaveError(null);
    void onSave(value).then((result) => {
      if (result === true) {
        draft.clear();
        return;
      }
      setSaveError(typeof result === "string" ? result : "We could not reach the site to save it.");
    });
  }

  const previewSlug = slug.trim() || defaultBlogSlug(title) || "your-post-title";
  const videoUrlIsYouTube = Boolean(videoUrl.trim() && extractYouTubeId(videoUrl.trim()));
  // What the server will store if the excerpt is left blank. Memoised because
  // it re-derives from the whole body, which changes on every keystroke.
  const derivedExcerpt = useMemo(() => deriveExcerpt(body), [body]);

  const formFields = (
    <div className="space-y-4">
      <div>
        <Label htmlFor="post-title">Title</Label>
        <Input
          id="post-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="post-slug">URL slug</Label>
        <Input
          id="post-slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          onBlur={() => {
            if (slug.trim()) setSlug(slugify(slug));
          }}
          placeholder="Leave blank to generate one from the title"
          className="mt-1.5"
        />
        <p className="mt-1 text-xs text-muted-foreground">jitsu.au/blog/{previewSlug}</p>
      </div>
      <div>
        <Label htmlFor="post-excerpt">Excerpt (shown on the blog list)</Label>
        <Textarea
          id="post-excerpt"
          value={excerpt}
          onChange={(e) => setExcerpt(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Leave blank to use the opening of the post"
          className="mt-1.5"
        />
        {!excerpt.trim() && (
          <p className="mt-1 text-xs text-muted-foreground">
            {derivedExcerpt
              ? `Blank, so the blog list will show: ${derivedExcerpt}`
              : "Blank, so the blog list will show the opening of the post once you write one."}
          </p>
        )}
      </div>
      <div>
        <Label htmlFor="post-cover-image">Cover image</Label>
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          {coverUrl && (
            <img
              src={coverUrl}
              alt="Cover image preview"
              className="h-16 w-24 rounded-md object-cover"
            />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploadingCover}
            aria-describedby="post-cover-image"
            onClick={() => coverInputRef.current?.click()}
          >
            {uploadingCover
              ? "Uploading..."
              : coverUrl
                ? "Replace cover image"
                : "Upload cover image"}
          </Button>
          <input
            id="post-cover-image"
            ref={coverInputRef}
            type="file"
            className="sr-only"
            accept={IMAGE_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleCoverImage(file);
              e.target.value = "";
            }}
          />
          {coverUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setCoverPath("");
                setCoverUrl(null);
              }}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <div>
        <Label htmlFor="post-body">Body (Markdown)</Label>
        <MarkdownEditor
          id="post-body"
          textareaRef={bodyRef}
          value={body}
          onChange={setBody}
          rows={18}
          tools={
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploadingImage}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => imageInputRef.current?.click()}
              >
                {uploadingImage ? "Uploading..." : "Insert image"}
              </Button>
              <input
                ref={imageInputRef}
                type="file"
                className="sr-only"
                aria-label="Insert image into post body"
                accept={IMAGE_ACCEPT}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleInsertImage(file);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setVideoUrl("");
                  setVideoDialogOpen(true);
                }}
              >
                Insert video
              </Button>
            </>
          }
        />
      </div>
      <div>
        <Label htmlFor="post-status">Status</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as BlogPostStatus)}>
          <SelectTrigger id="post-status" className="mt-1.5 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="published">Published</SelectItem>
          </SelectContent>
        </Select>
        {willUnpublish && (
          <p role="status" className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
            Saving takes this post off the public blog. You can publish it again any time.
          </p>
        )}
      </div>
    </div>
  );

  const previewCard = (
    <Card className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
      <CardHeader>
        <CardTitle className="text-base">Preview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-w-none">
          {splitBlogContent(body).map((block, i) =>
            block.type === "video" ? (
              <BlogVideoBlock key={i} url={block.url} title={title || "Preview"} className="my-4" />
            ) : (
              <ReactMarkdown key={i} components={blogMarkdownComponents}>
                {block.text}
              </ReactMarkdown>
            ),
          )}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div>
      {draft.offered && (
        <DraftRestoreBanner
          className="mb-4"
          what="post"
          savedAt={draft.offeredAt}
          onRestore={restoreDraft}
          onDiscard={draft.discard}
        />
      )}

      {/* Below `lg`, Write/Preview share the same space via a manual toggle
          rather than shadcn's Tabs: Tabs mounts both panels (or unmounts the
          inactive one) which would either duplicate every field's `id` or
          tear down the textarea's DOM node, losing native undo history. */}
      <div className="mb-4 inline-flex rounded-lg bg-muted p-1 text-sm lg:hidden">
        {(["write", "preview"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMobileTab(tab)}
            aria-pressed={mobileTab === tab}
            className={cn(
              "rounded-md px-3 py-1 font-medium capitalize transition-colors",
              mobileTab === tab ? "bg-background text-foreground shadow" : "text-muted-foreground",
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className={cn(mobileTab === "preview" && "hidden lg:block")}>{formFields}</div>
        <div className={cn(mobileTab === "write" && "hidden lg:block")}>{previewCard}</div>
      </div>

      {saveError && (
        <SaveFailure
          className="mt-6"
          what="post"
          message={saveError}
          retrying={saving}
          onRetry={handleSave}
        />
      )}

      <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t bg-background/95 px-4 py-3 backdrop-blur">
        <Button disabled={saving || !title.trim() || !body.trim()} onClick={handleSave}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      <Dialog open={videoDialogOpen} onOpenChange={setVideoDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert a video</DialogTitle>
            <DialogDescription>
              Paste a link. YouTube links embed inline; other links show as a plain "Watch the
              video" link.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="video-url">Video URL</Label>
            <Input
              id="video-url"
              autoFocus
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://youtu.be/..."
              className="mt-1.5"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmInsertVideo();
                }
              }}
            />
            {videoUrl.trim() && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {videoUrlIsYouTube
                  ? "This will embed inline."
                  : "This isn't a recognised YouTube link, so it will show as a plain link."}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setVideoDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={confirmInsertVideo} disabled={!videoUrl.trim()}>
              Insert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
