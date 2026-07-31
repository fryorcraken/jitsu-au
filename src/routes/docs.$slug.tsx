// Read a club document and annotate it.
//
// `robots: noindex` on purpose. These are the club's own documents (handbooks,
// policies, proposals) and most are members-only, so they are not marketing
// pages competing for search traffic — and a crawler that indexed one would list
// a URL whose content it is not allowed to fetch. Making a genuinely public,
// indexable document later is a deliberate change: drop the noindex, give the
// page a real canonical, and add it to `PUBLIC_PAGES` in `src/lib/seo.ts`
// (`seo.test.ts` enforces that pairing).
//
// Rendered client-side rather than in the loader: the annotation layer needs to
// know who is reading, and the reader's bearer token reaches a server function
// through `attachSupabaseAuth` on an RPC from the browser, not during SSR.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DocumentReader } from "@/components/site/DocumentReader";
import type { NewAnnotation } from "@/components/site/DocumentReader";
import {
  createAnnotation,
  deleteAnnotation,
  getDocument,
  listAnnotations,
  resolveAnnotation,
  updateAnnotation,
} from "@/lib/documents.functions";
import { formatDate } from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/docs/$slug")({
  head: () => ({
    meta: [{ title: "Document | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: DocumentPage,
});

function DocumentPage() {
  const { slug } = Route.useParams();
  const { loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const fetchDocument = useServerFn(getDocument);
  const fetchAnnotations = useServerFn(listAnnotations);
  const create = useServerFn(createAnnotation);
  const update = useServerFn(updateAnnotation);
  const remove = useServerFn(deleteAnnotation);
  const resolve = useServerFn(resolveAnnotation);

  const [busy, setBusy] = useState(false);

  // Wait for auth to settle before asking. The server resolves the reader from
  // the request's bearer token, so asking too early reads a members-only
  // document as a signed-out visitor and renders "not available to you" at
  // somebody who is, in fact, signed in.
  const documentQ = useQuery({
    queryKey: ["document", slug],
    queryFn: () => fetchDocument({ data: { slug } }),
    enabled: !authLoading,
    retry: false,
  });

  const annotationsQ = useQuery({
    queryKey: ["document-annotations", slug],
    queryFn: () => fetchAnnotations({ data: { slug } }),
    enabled: !authLoading && Boolean(documentQ.data),
  });

  const refreshAnnotations = () =>
    queryClient.invalidateQueries({ queryKey: ["document-annotations", slug] });

  /** Run a write, refresh the thread list, and report failures in words. */
  async function run(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    try {
      await action();
      await refreshAnnotations();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : failure);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || documentQ.isPending) {
    return (
      <SiteLayout>
        <section className="mx-auto max-w-3xl px-4 py-16">
          <p className="text-muted-foreground">Loading...</p>
        </section>
      </SiteLayout>
    );
  }

  if (documentQ.isError || !documentQ.data) {
    return (
      <SiteLayout>
        <section className="mx-auto max-w-3xl px-4 py-16">
          <h1 className="text-3xl font-bold">Document not available</h1>
          <p className="mt-3 text-muted-foreground">
            {documentQ.error instanceof Error
              ? documentQ.error.message
              : "That document does not exist, or is not available to you."}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <Link to="/docs">All documents</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/">Back home</Link>
            </Button>
          </div>
        </section>
      </SiteLayout>
    );
  }

  const { document, viewer } = documentQ.data;

  return (
    <SiteLayout>
      <section className="mx-auto max-w-6xl px-4 py-12 md:py-16">
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold md:text-4xl">{document.title}</h1>
            <Badge variant="outline">Version {document.version}</Badge>
            {document.visibility !== "public" && (
              <Badge variant="secondary">
                {document.visibility === "managers" ? "Managers only" : "Members"}
              </Badge>
            )}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Last updated {formatDate(document.updated_at)}
            {document.change_note ? ` — ${document.change_note}` : ""}
          </p>
          {!viewer.signed_in && (
            <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Link to="/auth" search={{ redirect: `/docs/${slug}` }} className="underline">
                Sign in
              </Link>{" "}
              to leave a comment or keep private notes on this document.
            </p>
          )}
        </div>

        <DocumentReader
          document={document}
          annotations={annotationsQ.data ?? []}
          viewer={viewer}
          busy={busy || annotationsQ.isFetching}
          onCreate={(input: NewAnnotation) =>
            run(
              () =>
                create({
                  data: {
                    slug,
                    document_version: document.version,
                    block_id: input.block_id ?? undefined,
                    quote: input.quote ?? undefined,
                    visibility: input.visibility,
                    parent_id: input.parent_id,
                    body: input.body,
                    hp: "",
                  },
                }),
              "Could not save your comment",
            )
          }
          onUpdate={(id, body) =>
            run(() => update({ data: { id, body } }), "Could not save your edit")
          }
          onDelete={(id) => run(() => remove({ data: { id } }), "Could not delete that")}
          onResolve={(id, resolved) =>
            run(() => resolve({ data: { id, resolved } }), "Could not update that thread")
          }
        />
      </section>
    </SiteLayout>
  );
}
