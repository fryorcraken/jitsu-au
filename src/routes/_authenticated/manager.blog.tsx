import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { Pill } from "@/components/site/StatusPill";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CopyButton } from "@/components/site/CopyButton";
import { blogPostClass } from "@/lib/status-colours";
import { canonicalUrl } from "@/lib/seo";
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useMemo(
    () => () => {
      setLoading(true);
      return fetchList()
        .then((data) => {
          setRows(data);
          setLoadError(null);
        })
        .catch((e) => {
          const message = describeLoadError(e, "Could not load posts");
          setLoadError(message);
          toast.error(message);
        })
        .finally(() => setLoading(false));
    },
    [fetchList],
  );

  useEffect(() => {
    if (!isManager) return;
    void load();
  }, [isManager, load]);

  async function onDelete(row: Row) {
    setDeletingId(row.id);
    try {
      await remove({ data: { id: row.id } });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      toast.success("Post deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete that post");
    } finally {
      setDeletingId(null);
      setPendingDelete(null);
    }
  }

  if (loading) return <Loading className="p-8" />;

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

      {loadError ? (
        <LoadFailure
          what="The posts"
          message={loadError}
          hint="This is not the same as having written none, so do not start a post over the top of one."
          onRetry={() => void load()}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No posts yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="p-3">
                  Title
                </th>
                <th scope="col" className="p-3">
                  Status
                </th>
                <th scope="col" className="p-3">
                  Published
                </th>
                <th scope="col" className="p-3">
                  Updated
                </th>
                <th scope="col" className="p-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-medium">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <Link
                        to="/manager/blog/$id"
                        params={{ id: row.id }}
                        className="hover:underline"
                      >
                        {row.title}
                      </Link>
                      {/* Next to the title, not with the row's other actions:
                          those sit off the right edge of a table this wide, so
                          on a phone they need a horizontal scroll to reach.
                          Only published posts get one: the public route reads
                          through the anon client with no session, so a draft's
                          URL is a 404 for everyone, managers included. */}
                      {row.status === "published" && (
                        <CopyButton
                          text={canonicalUrl(`/blog/${row.slug}`)}
                          label="Copy link"
                          ariaLabel={`Copy link to ${row.title}`}
                          className="shrink-0"
                        />
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <Pill label={row.status} className={blogPostClass(row.status)} />
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {row.published_at ? formatDateTime(row.published_at) : "—"}
                  </td>
                  <td className="p-3 text-muted-foreground">{formatDateTime(row.updated_at)}</td>
                  <td className="space-x-1 p-3 text-right">
                    {row.status === "published" && (
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/blog/$slug" params={{ slug: row.slug }} target="_blank">
                          View
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={deletingId === row.id}
                      onClick={() => setPendingDelete(row)}
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

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDelete?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This also deletes every comment on this post. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingDelete && onDelete(pendingDelete)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
