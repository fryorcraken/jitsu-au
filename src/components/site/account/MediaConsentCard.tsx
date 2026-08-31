import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loading } from "@/components/site/Loading";
import { SaveFailure } from "@/components/site/SaveFailure";
import { Pill } from "@/components/site/StatusPill";
import { mediaConsentClass } from "@/lib/status-colours";
import { mediaConsentLabel } from "@/lib/waiver-acknowledgements";
import { CardActions } from "./CardActions";
import { useDetailsSave, type DetailsCardProps } from "./DetailsCard";

/**
 * Whether the club may use photos and video of this member.
 *
 * Its own card rather than a line in Contact: that card is about how to reach
 * somebody, and burying a consent decision under a phone number is how people
 * end up never having made one. It also needs room to say that changing it here
 * takes effect now, without contradicting the waiver they signed.
 *
 * The member owns this one. A photo consent only a manager could withdraw would
 * be the wrong way round -- they are the person in the photograph.
 *
 * Two explicit buttons rather than a checkbox: a checkbox collapses "I was
 * asked and said no" and "nobody has asked me" into the same unticked box, and
 * the whole point of this card is letting someone actively refuse, not just
 * abstain. There is no "clear back to not asked" button here -- only a manager
 * can put a record back to that state (see the mirrored card on their user
 * page), because "not asked" stops being true the moment a member looks at
 * this control.
 */
export function MediaConsentCard({ userId, voice, profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save, saveError, clearSaveError, retrySave } = useDetailsSave({
    userId,
    profile,
    onSaved,
  });

  // `null` on file means nobody has ever asked, or a manager cleared it back to
  // that. The status badge and explainer below always reflect THIS (the
  // record on file), not the button the member has clicked but not yet saved,
  // so a selection they have not saved never reads as already recorded.
  const stored: boolean | null = useMemo(
    () =>
      profile?.media_consent === true || profile?.media_consent === false
        ? profile.media_consent
        : null,
    [profile?.media_consent],
  );
  const [consent, setConsent] = useState<boolean | null>(null);

  function choose(value: boolean) {
    setConsent(value);
    // The panel described the previous attempt. Changing the answer under it
    // would leave it claiming something about a choice it never saw.
    clearSaveError();
  }

  const revert = useMemo(() => () => setConsent(stored), [stored]);
  useEffect(revert, [revert]);

  const dirty = consent !== null && consent !== stored;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (consent === null) return;
    await save({ media_consent: consent }, "Saved", "Could not save that");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Photos and video</CardTitle>
        <CardDescription>
          We sometimes photograph or film classes to promote the club. Tell us whether we can use
          photos or video of {voice.who}, and change {voice.isSelf ? "your" : "the"} answer here any
          time. It does not rewrite a waiver already signed, which keeps what was ticked at the
          time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loading />
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {/* preserveCase: "Not asked" is a sentence, not an enum value. */}
              <Pill
                label={mediaConsentLabel(stored)}
                className={mediaConsentClass(stored)}
                preserveCase
              />
              <span className="text-sm text-muted-foreground">
                {stored === true
                  ? `We can use photos and video of ${voice.who} to promote the club. ${voice.Whose} name is never published alongside them.`
                  : stored === false
                    ? `We will not use any photo or video of ${voice.who}.`
                    : voice.isSelf
                      ? "You have not told us either way yet. Until you do, we will ask before using anything you are in."
                      : `Nobody has told us either way yet. Until somebody does, we will ask before using anything ${voice.who} is in.`}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={consent === true ? "default" : "outline"}
                aria-pressed={consent === true}
                onClick={() => choose(true)}
              >
                {voice.isSelf ? "Yes, I consent" : "Yes, we consent"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={consent === false ? "default" : "outline"}
                aria-pressed={consent === false}
                onClick={() => choose(false)}
              >
                {voice.isSelf ? "No, I don't consent" : "No, we don't consent"}
              </Button>
            </div>
            {saveError && (
              <SaveFailure
                what="answer"
                message={saveError}
                onRetry={() => void retrySave?.()}
                retrying={busy}
              />
            )}
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
