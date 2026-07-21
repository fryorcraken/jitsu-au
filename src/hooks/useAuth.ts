import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "manager" | "member";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setUser(s?.user ?? null);
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
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
