import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loading } from "@/components/site/Loading";
import { SaveFailure } from "@/components/site/SaveFailure";
import { commentDisplayName } from "@/lib/validation";
import { CardActions } from "./CardActions";
import { useDetailsSave, type DetailsCardProps } from "./DetailsCard";

/**
 * What the club calls this person, and what other members see next to their
 * comments. `commentDisplayName` doubles as the placeholder, so the field shows
 * exactly what will be used if they clear it.
 */
export function AboutYouCard({ userId, voice, profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save, saveError, clearSaveError, retrySave } = useDetailsSave({
    userId,
    profile,
    onSaved,
  });
  const [preferredName, setPreferredName] = useState("");
  const [displayName, setDisplayName] = useState("");

  // What is on file for the fields THIS card owns. Memoised on those values
  // alone, not on the whole `profile` object: saving any card replaces that
  // object, and resetting on its identity would silently wipe whatever the
  // member had typed into the other two cards but not yet saved.
  const stored = useMemo(
    () => ({
      preferredName: profile?.preferred_name ?? "",
      displayName: profile?.display_name ?? "",
    }),
    [profile?.preferred_name, profile?.display_name],
  );

  const revert = useMemo(
    () => () => {
      setPreferredName(stored.preferredName);
      setDisplayName(stored.displayName);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const dirty = preferredName !== stored.preferredName || displayName !== stored.displayName;

  const placeholder = profile ? commentDisplayName(profile) : "";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = displayName.trim();
    await save(
      {
        preferred_name: preferredName.trim() || null,
        display_name: name || null,
      },
      "Saved",
      "Could not save those names",
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{voice.isSelf ? "About you" : `About ${voice.who}`}</CardTitle>
        <CardDescription>
          {voice.isSelf
            ? "What we call you in person, and the name other members see on your comments."
            : `What we call ${voice.who} in person.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loading />
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="preferred-name">Preferred name</Label>
              <Input
                id="preferred-name"
                value={preferredName}
                onChange={(e) => {
                  setPreferredName(e.target.value);
                  clearSaveError();
                }}
                maxLength={60}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {voice.isSelf
                  ? "What you go by, if it is not your first name. We use it to greet you."
                  : `What ${voice.who} goes by, if it is not their first name. We use it to greet them.`}
              </p>
            </div>
            <div>
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  clearSaveError();
                }}
                maxLength={60}
                placeholder={placeholder}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Shown on your blog and document comments. Leave blank to use{" "}
                {placeholder ? `"${placeholder}"` : "your first name and last initial"}.
              </p>
            </div>
            {saveError && (
              <SaveFailure
                what={voice.isSelf ? "Your names" : `${voice.Whose} names`}
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
