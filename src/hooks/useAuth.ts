import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "manager" | "member";

/**
 * Whether two sessions differ in any way a screen could care about.
 *
 * supabase-js re-reads the stored session on every visibilitychange and hands
 * back a freshly built object each time, so comparing by reference makes every
 * return to the app look like a change. That re-rendered every consumer of this
 * hook (which is most of the signed-in app) for no reason at all, and any effect
 * keyed on `session` re-ran with it. Compare the two things that actually decide
 * what a screen shows instead: who it is, and which token their requests carry.
 */
function sameSession(a: Session | null, b: Session | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.user.id === b.user.id && a.access_token === b.access_token;
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const apply = (next: Session | null) => {
      setSession((current) => (sameSession(current, next) ? current : next));
      setUser((current) => {
        const nextUser = next?.user ?? null;
        // Keep the same `User` object while it is the same person, unchanged:
        // `user` is an effect dependency and a query-key ingredient all over the
        // app. `updated_at` is what moves when a profile or email really changes
        // (USER_UPDATED), so this holds identity steady without going stale.
        if (!current || !nextUser) return nextUser;
        if (current.id === nextUser.id && current.updated_at === nextUser.updated_at)
          return current;
        return nextUser;
      });
    };
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => apply(s));
    supabase.auth.getSession().then(({ data }) => {
      apply(data.session);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, user, loading };
}

export function useRoles(userId: string | undefined) {
  const [state, setState] = useState<{ userId: string | undefined; roles: AppRole[] }>({
    userId: undefined,
    roles: [],
  });

  useEffect(() => {
    if (!userId) {
      setState({ userId: undefined, roles: [] });
      return;
    }
    let cancelled = false;
    supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .then(({ data }) => {
        if (cancelled) return;
        setState({ userId, roles: (data ?? []).map((r) => r.role as AppRole) });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const loaded = state.userId === userId && userId !== undefined;
  const roles = loaded ? state.roles : [];
  return { roles, loading: !loaded && userId !== undefined, isManager: roles.includes("manager") };
}
