import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/site/StatusPill";
import { blogPostClass } from "@/lib/status-colours";
import { formatDateTime } from "@/lib/dates";
import { deleteBlogPost, listAllBlogPosts } from "@/lib/blog.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/blog")({
  head: () => ({
    meta: [{ title: "Blog posts | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: BlogPostsPage,
});

type Row = Awaited<ReturnType<typeof listAllBlogPosts>>[number];

function BlogPostsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchList = useServerFn(listAllBlogPosts);
  const remove = useServerFn(deleteBlogPost);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchList()
      .then(setRows)
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not load posts"))
      .finally(() => setLoading(false));
  }, [isManager, fetchList]);

  async function onDelete(row: Row) {
    if (!window.confirm(`Delete "${row.title}"? This also deletes its comments.`)) return;
    setDeletingId(row.id);
    try {
      await remove({ data: { id: row.id } });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      toast.success("Post deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete that post");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) return <div className="p-8">Loading...</div>;

  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Blog posts</h1>
          <p className="text-sm text-muted-foreground">
            Write, publish and edit posts on the public blog.
          </p>
        </div>
        <Button asChild>
          <Link to="/manager/blog/new">New post</Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No posts yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-3">Title</th>
                <th className="p-3">Status</th>
                <th className="p-3">Published</th>
                <th className="p-3">Updated</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-medium">
                    <Link
                      to="/manager/blog/$id"
                      params={{ id: row.id }}
                      className="hover:underline"
                    >
                      {row.title}
                    </Link>
                  </td>
                  <td className="p-3">
                    <Pill label={row.status} className={blogPostClass(row.status)} />
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {row.published_at ? formatDateTime(row.published_at) : "—"}
                  </td>
                  <td className="p-3 text-muted-foreground">{formatDateTime(row.updated_at)}</td>
                  <td className="p-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={deletingId === row.id}
                      onClick={() => onDelete(row)}
                    >
                      {deletingId === row.id ? "Deleting..." : "Delete"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
