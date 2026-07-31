import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { YouTubeEmbed } from "@/components/site/YouTubeEmbed";
import { uploadBlogImage } from "@/lib/blog.functions";
import { extractYouTubeId, splitBlogContent } from "@/lib/blog-content";
import { blogImageMimeTypes, type BlogImageMimeType, type BlogPostStatus } from "@/lib/validation";

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
}: {
  /** Undefined while composing a brand-new post: images upload under `drafts/`. */
  postId?: string;
  initial: BlogPostEditorValue;
  saving: boolean;
  onSave: (value: BlogPostEditorValue) => void;
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
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const upload = useServerFn(uploadBlogImage);

  /** Wrap the current selection in Markdown syntax (bold/italic/link/...),
   * mirroring the toolbar pattern from the waiver template editor. */
  function wrapSelection(before: string, after: string = before) {
    const el = bodyRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = body.slice(start, end);
    setBody(`${body.slice(0, start)}${before}${selected}${after}${body.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  function insertAtCursor(text: string) {
    const el = bodyRef.current;
    const pos = el ? el.selectionStart : body.length;
    setBody(`${body.slice(0, pos)}${text}${body.slice(pos)}`);
  }

  async function uploadFile(file: File): Promise<{ path: string; url: string } | null> {
    if (!isBlogImageMimeType(file.type)) {
      toast.error("That file type isn't supported. Use PNG, JPEG, WebP or GIF.");
      return null;
    }
    const data = await fileToBase64(file);
    return upload({ data: { post_id: postId, name: file.name, type: file.type, data } });
  }

  async function handleInsertImage(file: File) {
    setUploadingImage(true);
    try {
      const res = await uploadFile(file);
      if (res) insertAtCursor(`\n![${file.name}](${res.url})\n`);
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

  function handleInsertVideo() {
    const url = window.prompt(
      "Paste a video link (YouTube embeds inline; other links show as a link):",
    );
    if (!url?.trim()) return;
    insertAtCursor(`\n[[video:${url.trim()}]]\n`);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
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
            placeholder="Leave blank to generate one from the title"
            className="mt-1.5"
          />
        </div>
        <div>
          <Label htmlFor="post-excerpt">Excerpt (shown on the blog list)</Label>
          <Textarea
            id="post-excerpt"
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            rows={2}
            maxLength={500}
            className="mt-1.5"
          />
        </div>
        <div>
          <Label>Cover image</Label>
          <div className="mt-1.5 flex items-center gap-3">
            {coverUrl && (
              <img src={coverUrl} alt="" className="h-16 w-24 rounded-md object-cover" />
            )}
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              disabled={uploadingCover}
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
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => wrapSelection("**")}>
              Bold
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => wrapSelection("_")}>
              Italic
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => wrapSelection("\n## ", "")}
            >
              Heading
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => wrapSelection("\n- ", "")}
            >
              List
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => wrapSelection("[", "](https://)")}
            >
              Link
            </Button>
            <label>
              <Button type="button" variant="outline" size="sm" disabled={uploadingImage} asChild>
                <span>{uploadingImage ? "Uploading..." : "Insert image"}</span>
              </Button>
              <input
                type="file"
                className="hidden"
                accept={IMAGE_ACCEPT}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleInsertImage(file);
                  e.target.value = "";
                }}
              />
            </label>
            <Button type="button" variant="outline" size="sm" onClick={handleInsertVideo}>
              Insert video
            </Button>
          </div>
          <Textarea
            id="post-body"
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            className="mt-2 font-mono text-sm"
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
        </div>
        <Button
          disabled={saving || !title.trim() || !body.trim()}
          onClick={() =>
            onSave({
              title: title.trim(),
              slug: slug.trim(),
              excerpt: excerpt.trim(),
              body_md: body.trim(),
              cover_image_path: coverPath,
              cover_image_url: coverUrl,
              status,
            })
          }
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm max-w-none dark:prose-invert">
            {splitBlogContent(body).map((block, i) =>
              block.type === "video" ? (
                <VideoPreviewBlock key={i} url={block.url} title={title || "Preview"} />
              ) : (
                <ReactMarkdown key={i}>{block.text}</ReactMarkdown>
              ),
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function VideoPreviewBlock({ url, title }: { url: string; title: string }) {
  const videoId = extractYouTubeId(url);
  if (videoId) return <YouTubeEmbed videoId={videoId} title={title} className="not-prose my-4" />;
  return (
    <p>
      <a href={url} target="_blank" rel="noreferrer">
        Watch the video ↗
      </a>
    </p>
  );
}
