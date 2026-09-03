import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { Pill } from "@/components/site/StatusPill";
import { describeLoadError } from "@/lib/load-error";
import { formatDate } from "@/lib/dates";
import { waiverClass } from "@/lib/status-colours";
import { getWaiverPdfUrl, listMyWaivers } from "@/lib/waiver.functions";
import type { SubjectVoice } from "@/lib/subject-voice";

type MyWaiver = {
  id: string;
  signed_at: string;
  template_version: number | null;
  has_pdf: boolean;
  status: "pending" | "active" | "superseded";
};

/**
 * One person's waiver history.
 *
 * #110 recorded two things here that read a subject and did not write as one.
 * Both are closed now, which is what lets this card go in front of a parent
 * looking at a child:
 *
 *   * The download button goes through `getWaiverPdfUrl`, which was scoped by
 *     `public.waivers` RLS to the CALLER's own waivers. On a child's page every
 *     button would have rendered and every press would have failed. It now
 *     reads on the service role and asks the household gate, so a guardian gets
 *     the document (`waiverPdfPathForCaller`).
 *   * "Sign an updated waiver" linked to `/waiver`, which signs for whoever is
 *     signed in. Under a child's name that was the wrong person, silently. The
 *     link now carries the subject, and `/waiver` opens with that child already
 *     chosen.
 */
export function WaiversCard({ userId, voice }: { userId: string; voice: SubjectVoice }) {
  const fetchMine = useServerFn(listMyWaivers);
  const getUrl = useServerFn(getWaiverPdfUrl);
  const [waivers, setWaivers] = useState<MyWaiver[]>([]);
  const [loading, setLoading] = useState(true);
  // "No waivers on file yet." is the one sentence on this card that a member
  // acts on, by going and signing one they have already signed. It has to be
  // true when it is said.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return fetchMine({ data: { userId } })
      .then((rows) => {
        setWaivers(rows as MyWaiver[]);
        setLoadError(null);
      })
      .catch((e) => {
        setWaivers([]);
        setLoadError(describeLoadError(e, `Could not load ${voice.whose} waivers`));
      })
      .finally(() => setLoading(false));
  }, [fetchMine, userId, voice.whose]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(id: string) {
    try {
      const { url } = await getUrl({ data: { id } });
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the PDF. Try again.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Waivers</CardTitle>
        <CardDescription>
          {voice.Whose} waiver history. The active waiver is the latest one the club approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadFailure
            what={`${voice.Whose} waivers`}
            message={loadError}
            hint="This is not the same as having none on file, so there is nothing to sign again."
            onRetry={() => void load()}
          />
        ) : waivers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No waivers on file yet.</p>
        ) : (
          <ul className="space-y-2">
            {waivers.map((w) => (
              <li
                key={w.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span>
                  Signed {formatDate(w.signed_at)}
                  {w.template_version != null && (
                    <span className="text-muted-foreground"> (v{w.template_version})</span>
                  )}{" "}
                  {/* The same three statuses, and the same colours, a manager
                      sees. The two-way ternary this replaced painted a
                      superseded waiver exactly like a pending one, so a member
                      who had re-signed could not tell which one counted. */}
                  <Pill label={w.status} className={waiverClass(w.status)} />
                </span>
                {w.has_pdf && (
                  <Button size="sm" variant="outline" onClick={() => download(w.id)}>
                    Download PDF
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <Button asChild variant="outline" size="sm">
          {/* The subject rides along, so `/waiver` opens with this person
              already chosen rather than signing for whoever is logged in. */}
          <Link to="/waiver" search={voice.isSelf ? {} : { for: userId }}>
            Sign an updated waiver
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
