// The kit the four editable cards on an account page share: what they are
// handed, and how they save. Their buttons are `CardActions`.
//
// These cards are about a PERSON, not about the session. Each takes a `userId`
// and sends it with every write, so the same card can fetch and save the
// signed-in member's own details on `/account` or a dependant's elsewhere. The
// server decides who is allowed (`assertActingFor` in `src/lib/household.ts`);
// nothing here does.
//
// Both of the debts #110 recorded here are paid off, because #106 is the change
// that made them reachable.
//
// The first was the VOICE. Every string in these cards used to be second person
// ("About you", "your waiver history"), which is right on `/account` and wrong
// the moment a parent reads one under a child's name. They now take a `voice`
// alongside `userId` and address whoever they are about: `subjectVoice(null)`
// says "you" and "your", `subjectVoice("Bea")` says "Bea" and "Bea's". It lives
// in `@/lib/subject-voice`, because `/membership` needs it too and importing it
// from here dragged `profile.functions.ts` into that page.
//
// The second was a UX-bar debt: `save` reported a failed write with
// `toast.error`, and CLAUDE.md's "A failed SAVE is not a toast either" asks for
// a held error and `components/site/SaveFailure`. A member on bad reception
// saved their emergency contact, the write failed, the toast faded in four
// seconds, and the form still showed what they typed as though it had saved.
// `save` now holds a `saveError` for the card to render, and clears it when the
// form is edited so the panel never claims something about work it never saw.
//
// The page above them fetches the profile ONCE and passes it down, rather than
// each card fetching its own: they all read the same row, and three round trips
// would only give them three chances to disagree about what is on file.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { updateMyProfile } from "@/lib/profile.functions";
import type { getMyProfile } from "@/lib/waiver.functions";
import type { UpdateMyProfileFields } from "@/lib/validation";
import type { SubjectVoice } from "@/lib/subject-voice";

export type Profile = Awaited<ReturnType<typeof getMyProfile>>;

/** What every editable card on an account page is handed. */
export type DetailsCardProps = {
  /** The person these details belong to, who is not always the caller. */
  userId: string;
  /** How to refer to that person. Defaults to second person on `/account`. */
  voice: SubjectVoice;
  profile: Profile;
  loading: boolean;
  /** Called with the saved row so the page's copy of the profile stays true. */
  onSaved: (profile: Profile) => void;
};

/**
 * The shared save path for the editable cards: send only this card's keys,
 * fold them back into the page's profile, and say so.
 *
 * Returns the `busy` flag and a `save` the card calls with its own patch, so
 * each card owns its fields and nothing else. `userId` rides along with the
 * patch and is stripped by the handler before the UPDATE, so it can never be
 * mistaken for a field.
 */
export function useDetailsSave({
  userId,
  profile,
  onSaved,
}: Pick<DetailsCardProps, "userId" | "profile" | "onSaved">) {
  const update = useServerFn(updateMyProfile);
  const [busy, setBusy] = useState(false);
  // Held, not toasted. The panel stays on screen until the save succeeds or the
  // form is edited, so nobody walks away from a form that looks saved and is
  // not. A SUCCESS toast is still right: there is nothing left to act on.
  const [saveError, setSaveError] = useState<string | null>(null);
  // The last attempt, so the failure panel's button can try the same write
  // again rather than asking the member to press Save a second time.
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);

  async function save(patch: UpdateMyProfileFields, message: string, failure: string) {
    setBusy(true);
    setSaveError(null);
    try {
      await update({ data: { ...patch, userId } });
      if (profile) onSaved({ ...profile, ...patch } as Profile);
      setRetry(null);
      toast.success(message);
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : failure);
      setRetry(() => () => save(patch, message, failure));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Drop the panel because the form changed under it.
   *
   * Without this the panel outlives the attempt it describes: somebody edits a
   * field after a failure and is still being told that a save of something
   * else did not go through.
   */
  function clearSaveError() {
    setSaveError(null);
    setRetry(null);
  }

  return { busy, save, saveError, clearSaveError, retrySave: retry };
}
