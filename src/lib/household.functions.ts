// The household, over the wire.
//
// `household.ts` holds the rules (who may act for whom, who the club writes to,
// who is on an account). This is the thin server-function layer over them, kept
// separate for the reason every `*.functions.ts` module is: the rules stay pure
// and unit-testable, and the handler does nothing but authenticate and call
// them.
//
// One function today, because #105 needs exactly one thing: a parent filling in
// `/waiver` has to be able to pick a child already on their account rather than
// retype a name and a date of birth. #106 builds the screens that list a
// household properly and will grow this file; nothing is added here ahead of a
// caller.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isDependant, listHousehold } from "@/lib/household";

/** One person on the caller's account, as `/waiver`'s picker needs them. */
export type MyDependant = {
  user_id: string;
  first_name: string;
  /**
   * Carried even though no screen prints it. Picking a child prefills the
   * waiver form from these fields, and a middle name that came back missing
   * would be submitted blank and then promoted over the stored one at
   * approval: a field quietly erased by choosing the person it belongs to.
   */
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  date_of_birth: string | null;
};

/**
 * The people on the caller's account who have no login of their own.
 *
 * Only ever about the caller: there is no target parameter, so there is nothing
 * here to point at somebody else's household and `assertActingFor` has no
 * question to answer. A dependant who somehow held a session would get an empty
 * list, which is the truthful answer under the one-level rule.
 *
 * What it deliberately does NOT return is any email address. A dependant's is
 * the reserved, non-deliverable one, it identifies nobody, and no screen has
 * any use for it. The name and date of birth are what the picker shows and what
 * `resolveDependantId` matches on, so they are what this hands back.
 */
export const listMyDependants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyDependant[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const household = await listHousehold(supabaseAdmin, context.userId);
    return household.filter(isDependant).map((person) => ({
      user_id: person.user_id,
      first_name: person.first_name,
      middle_name: person.middle_name,
      last_name: person.last_name,
      preferred_name: person.preferred_name,
      date_of_birth: person.date_of_birth,
    }));
  });
