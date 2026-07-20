import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { listWaivers, getWaiverPdfUrl } from "@/lib/waiver.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { Download } from "lucide-react";

export const Route = createFileRoute("/_authenticated/manager/waivers")({
  head: () => ({ meta: [{ title: "Signed waivers | UTS Jitsu" }, { name: "robots", content: "noindex" }] }),
  component: WaiversPage,
});

type Row = {
  id: string;
  full_name: string;
  email: string;
  signed_at: string;
  template_version: number | null;
  pdf_path: string | null;
};

function WaiversPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchList = useServerFn(listWaivers);
  const getUrl = useServerFn(getWaiverPdfUrl);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/_authenticated/account" as never });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchList().then((data) => { setRows(data as Row[]); setLoading(false); })
      .catch((e) => { toast.error(e.message); setLoading(false); });
  }, [isManager, fetchList]);

  async function download(id: string) {
    try {
      const { url } = await getUrl({ data: { id } });
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to get PDF");
    }
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-5xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Signed waivers</h1>
            <p className="text-sm text-muted-foreground">All waivers signed via the website.</p>
          </div>
          <Button asChild variant="outline"><Link to="/_authenticated/account" as never}>Back to account</Link></Button>
        </div>

        {loading ? <p>Loading...</p> : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No waivers signed yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Signed</th>
                  <th className="px-3 py-2">Version</th>
                  <th className="px-3 py-2 text-right">PDF</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{r.full_name}</td>
                    <td className="px-3 py-2">{r.email}</td>
                    <td className="px-3 py-2">{new Date(r.signed_at).toLocaleString("en-AU")}</td>
                    <td className="px-3 py-2">v{r.template_version ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      {r.pdf_path ? (
                        <Button size="sm" variant="outline" onClick={() => download(r.id)}>
                          <Download className="mr-1 h-3 w-3" /> Download
                        </Button>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </SiteLayout>
  );
}
