// The kit the four editable cards on an account page share: what they are
// handed, and how they save. Their buttons are `CardActions`.
//
// These cards are about a PERSON, not about the session. Each takes a `userId`
// and sends it with every write, so the same card can fetch and save the
// signed-in member's own details on `/account` or a dependant's elsewhere. The
// server decides who is allowed (`assertActingFor` in `src/lib/household.ts`);
// nothing here does.
//
// ⚠️ This carries a UX-bar debt it did not create but has now promoted into
// shared code: `save` below reports a failed write with `toast.error`, and
// CLAUDE.md's "A failed SAVE is not a toast either" asks for a held `saveError`
// and `components/site/SaveFailure` instead. A member on bad reception saves
// their emergency contact, the write fails, the toast fades in four seconds,
// and the form still shows what they typed as though it saved. It is moved
// verbatim here so this refactor changes no behaviour, which means the fix is
// somebody's next change rather than nobody's.
//
// ⚠️ The person-agnostic claim above is true of the DATA and not yet of the VOICE. Every string in these
// cards is second person ("About you", "your waiver history", "photos or video
// of you"), which is correct on `/account` and wrong the first time a parent
// reads one under a child's name. A per-child page therefore needs a name or
// possessive threaded through alongside `userId`; it is not added here because
// nothing would pass it yet, and a prop with no caller is the generality
// CLAUDE.md rules out. #106 is where it belongs, and it is real work, not a
// drop-in.
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

export type Profile = Awaited<ReturnType<typeof getMyProfile>>;

/** What every editable card on an account page is handed. */
export type DetailsCardProps = {
  /** The person these details belong to, who is not always the caller. */
  userId: string;
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

  async function save(patch: UpdateMyProfileFields, message: string, failure: string) {
    setBusy(true);
    try {
      await update({ data: { ...patch, userId } });
      if (profile) onSaved({ ...profile, ...patch } as Profile);
      toast.success(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  return { busy, save };
}
