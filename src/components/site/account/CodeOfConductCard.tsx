import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { formatDate } from "@/lib/dates";
import { getCodeOfConductSigner } from "@/lib/code-of-conduct.functions";
import type { CodeOfConductState } from "@/lib/code-of-conduct";

/**
 * Where this person stands on the club's house rules.
 *
 * Reads through the same server function the public page uses: a signed-in
 * caller is identified by their session, so no token is involved here. Signing
 * itself happens on `/code-of-conduct`, because agreeing to a document you
 * cannot see on the same screen is not agreement.
 *
 * ⚠️ The READ takes a subject; the button does not. `/code-of-conduct` records
 * an acceptance for whoever is signed in, and `acceptCodeOfConduct` has no
 * target, so a parent reading "You have not agreed to it yet" under a child's
 * name and pressing the button would file the PARENT's agreement and leave the
 * child's card unchanged. Nobody would be told. That is the same silent
 * wrong-person write the household project exists to end, so a per-child page
 * must not ship this button until signing itself takes a subject.
 */
export function CodeOfConductCard({ userId }: { userId: string }) {
  const fetchSigner = useServerFn(getCodeOfConductSigner);
  const [state, setState] = useState<CodeOfConductState | null>(null);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Swallowed, this card fell back to the "please read and agree" prompt, which
  // asks somebody who agreed last month to do it again.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return fetchSigner({ data: { token: "", userId } })
      .then((res) => {
        setLoadError(null);
        if (!res.status) return;
        setState(res.status.state);
        setAcceptedAt(res.status.accepted_at);
        setAcceptedVersion(res.status.accepted_version);
      })
      .catch((e) => {
        setLoadError(describeLoadError(e, "Could not load your code of conduct"));
      })
      .finally(() => setLoading(false));
  }, [fetchSigner, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Code of conduct</CardTitle>
        <CardDescription>
          The rules we train by. Signing it is not required before you train, and we ask for it
          around the time you join as a paying member.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadFailure
            what="Whether you have agreed to this"
            message={loadError}
            hint="If you have already agreed, that still stands."
            onRetry={() => void load()}
          />
        ) : state === "signed" ? (
          <p className="text-sm text-muted-foreground">
            You agreed to version {acceptedVersion} on {formatDate(acceptedAt)}.
          </p>
        ) : state === "outdated" ? (
          <p className="text-sm text-muted-foreground">
            You agreed to version {acceptedVersion} on {formatDate(acceptedAt)}. We have updated it
            since, so please have another read.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">You have not agreed to it yet.</p>
        )}
        <Button asChild variant={state === "signed" ? "outline" : "default"} size="sm">
          <Link to="/code-of-conduct" search={{ t: undefined }}>
            {state === "signed" ? "Read the code of conduct" : "Read and sign it"}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
