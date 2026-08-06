import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BlogPostEditor, type BlogPostEditorValue } from "@/components/site/BlogPostEditor";
import { getBlogPostForEdit, updateBlogPost } from "@/lib/blog.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/blog_/$id")({
  head: () => ({
    meta: [{ title: "Edit post | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: EditBlogPostPage,
});

type PostRow = Awaited<ReturnType<typeof getBlogPostForEdit>>;

function EditBlogPostPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchPost = useServerFn(getBlogPostForEdit);
  const update = useServerFn(updateBlogPost);

  const [post, setPost] = useState<PostRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchPost({ data: { id } })
      .then(setPost)
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not load that post"))
      .finally(() => setLoading(false));
  }, [isManager, id, fetchPost]);

  function goBack() {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    navigate({ to: "/manager/blog" });
  }

  async function onSave(value: BlogPostEditorValue) {
    setSaving(true);
    try {
      const res = await update({
        data: {
          id,
          title: value.title,
          slug: value.slug,
          excerpt: value.excerpt,
          body_md: value.body_md,
          cover_image_path: value.cover_image_path,
          status: value.status,
        },
      });
      toast.success(value.status === "published" ? "Post published" : "Draft saved");
      // Reflect exactly what was saved as the new baseline — including the
      // slug and excerpt the server actually resolved (a slug collision or a
      // re-derivation when either field was cleared) — so the "unsaved
      // changes" comparison in BlogPostEditor resets instead of reading as
      // dirty right after a successful save.
      setPost((prev) =>
        prev
          ? {
              ...prev,
              title: value.title,
              slug: res.slug,
              excerpt: res.excerpt,
              body_md: value.body_md,
              cover_image_path: value.cover_image_path || null,
              cover_image_url: value.cover_image_url,
              status: value.status,
            }
          : prev,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that post");
    } finally {
      setSaving(false);
    }
  }

  // Stable object identity: BlogPostEditor re-seeds its fields whenever this
  // reference changes, so a fresh literal here on every render would wipe
  // out every keystroke as soon as `onDirtyChange` causes this page to
  // re-render (see BlogPostEditor's re-seed effect). Keying on `post` keeps
  // the reference stable across those renders, only changing on a genuine
  // new baseline (initial fetch, or after a successful save).
  const initial = useMemo<BlogPostEditorValue | null>(
    () =>
      post && {
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt ?? "",
        body_md: post.body_md,
        cover_image_path: post.cover_image_path ?? "",
        cover_image_url: post.cover_image_url,
        status: post.status === "published" ? "published" : "draft",
      },
    [post],
  );

  if (loading) return <div className="p-8">Loading...</div>;
  if (!post || !initial) return null;

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-black">Edit post</h1>
        <Button variant="outline" onClick={goBack}>
          Back to posts
        </Button>
      </div>
      <BlogPostEditor
        postId={post.id}
        initial={initial}
        saving={saving}
        onSave={onSave}
        onDirtyChange={setDirty}
      />
    </section>
  );
}
