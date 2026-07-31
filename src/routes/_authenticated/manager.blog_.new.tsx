import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BlogPostEditor, type BlogPostEditorValue } from "@/components/site/BlogPostEditor";
import { createBlogPost } from "@/lib/blog.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/blog_/new")({
  head: () => ({
    meta: [{ title: "New post | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: NewBlogPostPage,
});

function NewBlogPostPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const create = useServerFn(createBlogPost);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  async function onSave(value: BlogPostEditorValue) {
    setSaving(true);
    try {
      await create({
        data: {
          title: value.title,
          slug: value.slug,
          excerpt: value.excerpt,
          body_md: value.body_md,
          cover_image_path: value.cover_image_path,
          status: value.status,
        },
      });
      toast.success(value.status === "published" ? "Post published" : "Draft saved");
      navigate({ to: "/manager/blog" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that post");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-black">New post</h1>
        <Button asChild variant="outline">
          <Link to="/manager/blog">Back to posts</Link>
        </Button>
      </div>
      <BlogPostEditor
        initial={{
          title: "",
          slug: "",
          excerpt: "",
          body_md: "",
          cover_image_path: "",
          cover_image_url: null,
          status: "draft",
        }}
        saving={saving}
        onSave={onSave}
      />
    </section>
  );
}
