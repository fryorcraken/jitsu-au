// Typed wrappers for the Postgres functions this app calls by RPC.
//
// WHY THIS FILE EXISTS: the generated Supabase types get function-return
// NULLABILITY wrong, and cannot do otherwise. Nullability in Postgres is a
// column property (`pg_attribute.attnotnull`), which is why the generated
// `Row` types are accurate. A function's results are not columns: `RETURNS
// TABLE (...)` compiles to OUT parameters, recorded in `pg_proc` as names and
// types only, with no nullability bit to read. So the generator prints the bare
// type for every function return, and everything in `Database["public"]
// ["Functions"]` reads as non-null whether or not it is.
//
// Hand-correcting `types.ts` does not hold: it is regenerated from the live
// database, and every regeneration erases the edit (it has, once already).
// So the truth lives here instead, in a file we own, and the server functions
// call these instead of `.rpc()` directly. Regeneration can then say whatever
// it likes without making the app's types wrong.
//
// Only the functions whose real nullability differs from the generated one need
// a wrapper. `has_role` and `has_active_paid_membership` are `SELECT EXISTS(...)`
// and never return NULL, so they are fine called directly.
import type { ClubUserEmail } from "./club-users";

/**
 * Any Supabase client, whichever generated `Database` generic it carries.
 *
 * Structural rather than `SupabaseClient<Database>` because the callers hold
 * several different client types (`MembershipClient`, `CheckinClient`,
 * `AppClient`, the plain admin client), and this module's whole purpose is to
 * stop deriving its result types from the generated ones anyway.
 */
type RpcCapable = { rpc: unknown };

type RawRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Call an RPC without the generated return type.
 *
 * `.rpc()` is typed per function name from `Database["public"]["Functions"]`,
 * which is exactly the typing this module exists to override — so the widening
 * happens here, once, instead of as a cast at every call site. `.call(db, ...)`
 * rather than a plain call because the real method is bound to its client.
 */
function callRpc(db: RpcCapable, fn: string, args: Record<string, unknown>) {
  return (db.rpc as RawRpc).call(db, fn, args);
}

/** The `{ data, error }` shape PostgREST returns, so call sites keep their own
 * error handling exactly as it was. */
export type RpcResult<T> = { data: T | null; error: { message: string } | null };

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
