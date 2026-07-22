import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { listWaivers, getWaiverPdfUrl } from "@/lib/waiver.functions";
import {
  getGoogleDriveStatus,
  listMyDriveUploads,
  uploadWaiverToDrive,
} from "@/lib/google-drive.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { Download, Cloud, CloudCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/manager/waivers")({
  head: () => ({
    meta: [{ title: "Signed waivers | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
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

type DriveUpload = {
  waiver_id: string;
  drive_file_id: string | null;
  drive_web_view_link: string | null;
  uploaded_at: string | null;
};

function WaiversPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchList = useServerFn(listWaivers);
  const getUrl = useServerFn(getWaiverPdfUrl);
  const fetchDriveStatus = useServerFn(getGoogleDriveStatus);
  const fetchDriveUploads = useServerFn(listMyDriveUploads);
  const upload = useServerFn(uploadWaiverToDrive);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [driveConnected, setDriveConnected] = useState(false);
  const [uploads, setUploads] = useState<Record<string, DriveUpload>>({});
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchList()
      .then((data) => {
        setRows(data as Row[]);
        setLoading(false);
      })
      .catch((e) => {
        toast.error(e.message);
        setLoading(false);
      });
    fetchDriveStatus()
      .then((s) => setDriveConnected(s.connected))
      .catch(() => setDriveConnected(false));
    fetchDriveUploads()
      .then((list) => {
        const map: Record<string, DriveUpload> = {};
        for (const u of list) map[u.waiver_id] = u;
        setUploads(map);
      })
      .catch(() => {});
  }, [isManager, fetchList, fetchDriveStatus, fetchDriveUploads]);

  async function download(id: string) {
    try {
      const { url } = await getUrl({ data: { id } });
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to get PDF");
    }
  }

  async function saveToDrive(id: string) {
    setUploadingId(id);
    try {
      const res = await upload({ data: { waiverId: id } });
      setUploads((prev) => ({
        ...prev,
        [id]: {
          waiver_id: id,
          drive_file_id: res.driveFileId,
          drive_web_view_link: res.webViewLink,
          uploaded_at: new Date().toISOString(),
        },
      }));
      toast.success("Saved to Google Drive");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingId(null);
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
          <Button asChild variant="outline">
            <Link to="/account">Back to account</Link>
          </Button>
        </div>

        {!driveConnected && (
          <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Connect Google Drive on your{" "}
            <Link to="/account" className="underline">
              account page
            </Link>{" "}
            to save waivers directly to your Drive.
          </div>
        )}

        {loading ? (
          <p>Loading...</p>
        ) : rows.length === 0 ? (
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
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const up = uploads[r.id];
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{r.full_name}</td>
                      <td className="px-3 py-2">{r.email}</td>
                      <td className="px-3 py-2">{new Date(r.signed_at).toLocaleString("en-AU")}</td>
                      <td className="px-3 py-2">v{r.template_version ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {r.pdf_path ? (
                            <Button size="sm" variant="outline" onClick={() => download(r.id)}>
                              <Download className="mr-1 h-3 w-3" /> PDF
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                          {driveConnected && r.pdf_path ? (
                            up?.drive_web_view_link ? (
                              <Button size="sm" variant="outline" asChild>
                                <a
                                  href={up.drive_web_view_link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <CloudCheck className="mr-1 h-3 w-3" /> In Drive
                                </a>
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => saveToDrive(r.id)}
                                disabled={uploadingId === r.id}
                              >
                                <Cloud className="mr-1 h-3 w-3" />
                                {uploadingId === r.id ? "Saving..." : "Save to Drive"}
                              </Button>
                            )
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </SiteLayout>
  );
}
