// The list of club documents this reader may open.
//
// `noindex`, for the same reason as the reader itself: most of what is listed
// here is members-only, and the index would otherwise advertise the slug of
// every managers-only draft to a crawler that cannot read any of them.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Badge } from "@/components/ui/badge";
import { listDocuments } from "@/lib/documents.functions";
import { formatDate } from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [{ title: "Documents | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: DocumentsIndex,
});

function DocumentsIndex() {
  const { loading: authLoading } = useAuth();
  const fetchDocuments = useServerFn(listDocuments);

  // Same reason the reader waits: the list is filtered by who is asking, and
  // asking before auth settles shows a member the signed-out list.
  const documentsQ = useQuery({
    queryKey: ["documents"],
    queryFn: () => fetchDocuments(),
    enabled: !authLoading,
  });

  const documents = documentsQ.data ?? [];

  return (
    <SiteLayout>
      <section className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-4xl font-bold">Documents</h1>
        <p className="mt-3 text-muted-foreground">
          Club documents you can read and comment on. Your private notes stay private.
        </p>

        <div className="mt-10 space-y-3">
          {authLoading || documentsQ.isPending ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There are no documents available to you yet.
            </p>
          ) : (
            documents.map((doc) => (
              <Link
                key={doc.slug}
                to="/docs/$slug"
                params={{ slug: doc.slug }}
                className="flex items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50"
              >
                <FileText className="mt-0.5 h-5 w-5 flex-none text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{doc.title}</span>
                    {doc.visibility !== "public" && (
                      <Badge variant="secondary" className="text-[10px]">
                        {doc.visibility === "managers" ? "Managers only" : "Members"}
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Version {doc.version} · updated {formatDate(doc.updated_at)}
                  </span>
                </span>
              </Link>
            ))
          )}
        </div>
      </section>
    </SiteLayout>
  );
}
