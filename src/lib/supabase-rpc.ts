// Typed wrappers for the Postgres functions this app calls by RPC.
//
// WHY THIS FILE EXISTS: the generated Supabase types get function-return
// NULLABILITY wrong, and cannot do otherwise.
//
// A function's declared return type never says whether it can return NULL, and
// there is nowhere for the generator to look it up. A scalar function returns
// NULL whenever its body selects no row — `user_id_by_email` is `SELECT id ...
// LIMIT 1`, so an unknown address yields NULL. A `RETURNS TABLE (...)` function
// declares OUT parameters, recorded in `pg_proc` as names and types only, with
// no `attnotnull` to read; that is the bit the generator DOES read for table
// columns, which is why the generated `Row` types are accurate and these are
// not. So everything under `Database["public"]["Functions"]` prints its bare
// declared type, non-null, whether or not that is true.
//
// Hand-correcting `types.ts` does not hold: it is regenerated from the live
// database, and every regeneration erases the edit (it has, once already).
// So the truth lives here instead, in a file we own, and the server functions
// call these instead of `.rpc()` directly. Regeneration can then say whatever
// it likes without making the app's types wrong.
//
// Only the functions whose real nullability differs from the generated one need
// a wrapper. `has_role` and `has_active_paid_membership` are `SELECT EXISTS(...)`
// and never return NULL; `clear_email_confirmation` returns void and its callers
// read only `error`. Those are all fine called directly.
//
// `notification_digest_key` joins `user_id_by_email` in needing one: it is
// `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ... LIMIT 1`,
// so it returns NULL exactly when nobody has minted the secret yet — the state
// this app started in, and the state the endpoint's 503 branch exists for.
import type { Database } from "@/integrations/supabase/types";
import type { ClubUserEmail } from "./club-users";

/** The functions the generated types know about, and the arguments each takes.
 * Only the RETURN types are untrustworthy: names and argument names come
 * straight out of `pg_proc` and are as reliable as the table types. */
type RpcName = keyof Database["public"]["Functions"];
type RpcArgs<N extends RpcName> = Database["public"]["Functions"][N]["Args"];

/** PostgREST's error, kept structural so a call site can still read `code` /
 * `details` / `hint`, and a test can hand over a bare `{ message }`. */
export type PostgrestErrorLike = {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

/**
 * Any Supabase client, whichever generated `Database` generic it carries.
 *
 * Structural rather than `SupabaseClient<Database>` because callers hold it
 * under several aliases, and this module deliberately does not take its result
 * types from the generated ones. The signature stays callable, so an object
 * that merely has an `rpc` property of some other type is still rejected.
 */
type RpcCapable = {
  rpc: <N extends RpcName>(
    fn: N,
    args: RpcArgs<N>,
  ) => PromiseLike<{ data: unknown; error: PostgrestErrorLike | null }>;
};

/**
 * Call an RPC, keeping the generated argument checking and dropping only the
 * generated RETURN type — the one part of `Functions` that cannot be trusted.
 *
 * Routing `fn` and `args` through `RpcName` / `RpcArgs` keeps the compile-time
 * bind between these calls and the live schema: rename the function or one of
 * its parameters and this stops building, which is where that should fail. Only
 * `data` is widened, and each wrapper below re-narrows it to the shape the
 * database actually returns.
 *
 * `.call(db, ...)` rather than a plain call because the real method reads
 * `this` — it delegates to the client's REST handle.
 */
function callRpc<N extends RpcName>(db: RpcCapable, fn: N, args: RpcArgs<N>) {
  return db.rpc.call(db, fn, args) as PromiseLike<{
    data: unknown;
    error: PostgrestErrorLike | null;
  }>;
}

/** The `{ data, error }` shape PostgREST returns, so call sites keep their own
 * error handling exactly as it was. */
export type RpcResult<T> = { data: T | null; error: PostgrestErrorLike | null };

/**
 * Resolve an email address to the person's auth user id.
 *
 * **Returns null when nobody has that address**, which is the normal case and
 * the reason the function exists: `submitWaiverWithPdf` branches on it to
 * decide between "this person already exists" and "create a locked applicant".
 * The generated type says `string`, which is a lie in the most common path.
 */
export async function userIdByEmail(
  db: RpcCapable,
  email: string,
): Promise<RpcResult<string | null>> {
  const { data, error } = await callRpc(db, "user_id_by_email", { _email: email });
  return { data: (data as string | null) ?? null, error };
}

/**
 * Resolve auth user ids to their addresses and verification stamps.
 *
 * `email_confirmed_at` is `auth.users.email_confirmed_at`, which is NULL for
 * everyone who has never proved they can read their address — the majority of
 * people, and precisely the state the manager screens badge. The generated type
 * says `string`, i.e. "everybody is verified".
 *
 * `email` stays non-null here. `auth.users.email` is nullable in general
 * (Supabase allows phone-only accounts), but this app has no signup path that
 * creates one: every person is born from a waiver submission with an address.
 */
export async function userEmails(
  db: RpcCapable,
  userIds: string[],
): Promise<RpcResult<ClubUserEmail[]>> {
  const { data, error } = await callRpc(db, "user_emails", { _user_ids: userIds });
  return { data: (data as ClubUserEmail[] | null) ?? null, error };
}

/**
 * Read the daily digest's bearer token out of Supabase Vault.
 *
 * **Returns null when the secret has not been minted or has been removed**,
 * which is the digest endpoint's "not configured" state and the reason
 * `src/routes/api/notifications/digest.ts` answers 503 rather than 401 for it.
 * The generated type says `string`, which would make that branch unreachable.
 */
export async function notificationDigestKey(db: RpcCapable): Promise<RpcResult<string | null>> {
  const { data, error } = await callRpc(db, "notification_digest_key", {});
  return { data: (data as string | null) ?? null, error };
}
