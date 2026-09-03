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
import type { SubjectVoice } from "@/lib/subject-voice";

/**
 * Where this person stands on the club's house rules.
 *
 * Reads through the same server function the public page uses: a signed-in
 * caller is identified by their session, so no token is involved here. Signing
 * itself happens on `/code-of-conduct`, because agreeing to a document you
 * cannot see on the same screen is not agreement.
 *
 * #110 recorded that the READ took a subject and the button did not, so a
 * parent pressing it under a child's name would have filed their OWN
 * agreement and left the child's card unchanged, with nobody told.
 * `acceptCodeOfConduct` now takes a target, so the button carries the subject
 * and the agreement is filed against the right person.
 *
 * This is also the route #111 named when it deliberately put no
 * code-of-conduct link on a child's waiver: a token proves an address, and a
 * token minted for a child could never be opened by the parent it was posted
 * to. A parent signs it here instead, where there is a live session for
 * `assertActingFor` to check.
 */
export function CodeOfConductCard({ userId, voice }: { userId: string; voice: SubjectVoice }) {
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
        setLoadError(describeLoadError(e, `Could not load ${voice.whose} code of conduct`));
      })
      .finally(() => setLoading(false));
  }, [fetchSigner, userId, voice.whose]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Code of conduct</CardTitle>
        <CardDescription>
          The rules we train by. Signing it is not required before{" "}
          {voice.isSelf ? "you train" : `${voice.who} trains`}, and we ask for it around the time{" "}
          {voice.isSelf ? "you join" : "they join"} as a paying member.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadFailure
            what={voice.isSelf ? "Whether you have agreed to this" : "Whether this is agreed"}
            message={loadError}
            hint="If it has already been agreed to, that still stands."
            onRetry={() => void load()}
          />
        ) : state === "signed" ? (
          <p className="text-sm text-muted-foreground">
            {voice.isSelf ? "You agreed" : `Agreed for ${voice.who}`} to version {acceptedVersion}{" "}
            on {formatDate(acceptedAt)}.
          </p>
        ) : state === "outdated" ? (
          <p className="text-sm text-muted-foreground">
            {voice.isSelf ? "You agreed" : `Agreed for ${voice.who}`} to version {acceptedVersion}{" "}
            on {formatDate(acceptedAt)}. We have updated it since, so please have another read.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {voice.isSelf ? "You have not agreed to it yet." : `Not agreed for ${voice.who} yet.`}
          </p>
        )}
        <Button asChild variant={state === "signed" ? "outline" : "default"} size="sm">
          {/* The subject rides along, so a parent signing from a child's page
              files the agreement against the CHILD. Without it the button would
              quietly record the parent agreeing for themselves again. */}
          <Link
            to="/code-of-conduct"
            search={voice.isSelf ? { t: undefined } : { t: undefined, for: userId }}
          >
            {state === "signed"
              ? "Read the code of conduct"
              : voice.isSelf
                ? "Read and sign it"
                : `Read and sign it for ${voice.who}`}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
