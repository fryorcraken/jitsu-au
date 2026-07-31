import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
      if (res.slug !== value.slug) {
        // The slug changed (collision resolved, or the manager cleared the
        // field to re-derive one) — reflect what was actually saved rather
        // than leaving the form showing a slug the post isn't at.
        setPost((prev) => (prev ? { ...prev, slug: res.slug } : prev));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that post");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-8">Loading...</div>;
  if (!post) return null;

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-black">Edit post</h1>
        <Button asChild variant="outline">
          <Link to="/manager/blog">Back to posts</Link>
        </Button>
      </div>
      <BlogPostEditor
        postId={post.id}
        initial={{
          title: post.title,
          slug: post.slug,
          excerpt: post.excerpt ?? "",
          body_md: post.body_md,
          cover_image_path: post.cover_image_path ?? "",
          cover_image_url: post.cover_image_url,
          status: post.status === "published" ? "published" : "draft",
        }}
        saving={saving}
        onSave={onSave}
      />
    </section>
  );
}
