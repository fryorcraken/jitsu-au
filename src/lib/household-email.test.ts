// Which address belongs to a person, once some people have no address of their
// own. What is pinned here is the SPLIT: sending and showing are different
// questions with different answers, and the reserved address a dependant's
// login carries is never the answer to either.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  contactUserIdOf,
  deliveryEmailFor,
  householdContacts,
  loadHouseholdContacts,
} from "./household-email";

const PARENT = {
  user_id: "parent",
  guardian_user_id: null,
  first_name: "Ada",
  middle_name: null,
  last_name: "Lovelace",
  preferred_name: null,
};
const CHILD = {
  user_id: "child",
  guardian_user_id: "parent",
  first_name: "Bea",
  middle_name: null,
  last_name: "Lovelace",
  preferred_name: null,
};
const SIBLING = {
  user_id: "sibling",
  guardian_user_id: "parent",
  first_name: "Cy",
  middle_name: null,
  last_name: "Lovelace",
  preferred_name: null,
};

const PARENT_EMAIL = { user_id: "parent", email: "ada@example.com" };

describe("householdContacts", () => {
  const contacts = householdContacts({
    people: [PARENT, CHILD, SIBLING],
    emails: [PARENT_EMAIL],
  });

  it("sends an account holder's mail to their own address", () => {
    expect(contacts.deliveryEmail("parent")).toBe("ada@example.com");
  });

  it("sends a dependant's mail to their guardian", () => {
    expect(contacts.deliveryEmail("child")).toBe("ada@example.com");
    expect(contacts.deliveryEmail("sibling")).toBe("ada@example.com");
  });

  it("shows an account holder's address with no caption", () => {
    expect(contacts.displayEmail("parent")).toEqual({
      email: "ada@example.com",
      onBehalfOf: null,
    });
  });

  it("shows a dependant's guardian's address AND says whose it is", () => {
    // The caption is the point. A bare address under a nine-year-old's name
    // reads as a mailbox somebody could write to.
    expect(contacts.displayEmail("child")).toEqual({
      email: "ada@example.com",
      onBehalfOf: { user_id: "parent", name: "Ada Lovelace" },
    });
  });

  it("treats a person it has never heard of as an account holder", () => {
    // Not this module's job to decide what a missing profile row means, and
    // failing closed here would blank the address of anyone mid-migration.
    expect(
      householdContacts({ people: [], emails: [PARENT_EMAIL] }).displayEmail("parent"),
    ).toEqual({ email: "ada@example.com", onBehalfOf: null });
  });

  it("says which person the club writes to", () => {
    expect(contacts.contactUserId("child")).toBe("parent");
    expect(contacts.contactUserId("parent")).toBe("parent");
  });

  it("is case-insensitive about ids, as the gate is", () => {
    expect(contacts.deliveryEmail("CHILD")).toBe("ada@example.com");
  });

  it("reports no address rather than guessing when the guardian's is missing", () => {
    const none = householdContacts({ people: [PARENT, CHILD], emails: [] });
    expect(none.deliveryEmail("child")).toBeNull();
    // Still names the guardian: a screen can say whose address is missing.
    expect(none.displayEmail("child").onBehalfOf?.name).toBe("Ada Lovelace");
  });
});

/**
 * Fake admin serving the two reads `loadHouseholdContacts` makes, and RECORDING
 * which ids the address RPC was asked about.
 *
 * That recording is the point of the test below. The guarantee this module
 * makes is not "the reserved address is filtered out on the way to the screen"
 * but "it is never looked up at all", and only a fake that remembers what was
 * asked can tell those two apart.
 */
function admin(rows: (typeof PARENT)[], emails: { user_id: string; email: string }[]) {
  const rpcCalls: string[][] = [];
  const client = {
    rpc: (name: string, args: { _user_ids: string[] }) => {
      expect(name).toBe("user_emails");
      rpcCalls.push(args._user_ids);
      return Promise.resolve({
        data: emails.filter((e) => args._user_ids.includes(e.user_id)),
        error: null,
      });
    },
    from: (table: string) => {
      expect(table).toBe("profiles");
      return {
        select: () => ({
          in: (_col: string, ids: string[]) =>
            Promise.resolve({ data: rows.filter((r) => ids.includes(r.user_id)), error: null }),
          eq: (_col: string, id: string) => ({
            maybeSingle: () =>
              Promise.resolve({ data: rows.find((r) => r.user_id === id) ?? null, error: null }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, rpcCalls };
}

describe("loadHouseholdContacts", () => {
  it("never asks for a dependant's own address", async () => {
    const { client, rpcCalls } = admin([PARENT, CHILD, SIBLING], [PARENT_EMAIL]);
    const contacts = await loadHouseholdContacts(client, ["child", "sibling"]);

    expect(contacts.deliveryEmail("child")).toBe("ada@example.com");
    // One call, and the two children's own ids are not in it. A dependant's
    // reserved address never enters this process, so there is nothing to leak
    // from a field somebody adds later.
    expect(rpcCalls).toEqual([["parent"]]);
    expect(rpcCalls.flat()).not.toContain("child");
    expect(rpcCalls.flat()).not.toContain("sibling");
  });

  it("reads the guardian's profile so a display can name them", async () => {
    // The guardian was not among the ids asked about, so their name has to be
    // fetched or the screen has nothing to caption the address with.
    const { client } = admin([PARENT, CHILD], [PARENT_EMAIL]);
    const contacts = await loadHouseholdContacts(client, ["child"]);
    expect(contacts.displayEmail("child").onBehalfOf).toEqual({
      user_id: "parent",
      name: "Ada Lovelace",
    });
  });

  it("degrades to no address when the RPC fails, rather than throwing", async () => {
    const client = {
      rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
      from: () => ({
        select: () => ({ in: () => Promise.resolve({ data: [PARENT], error: null }) }),
      }),
    } as unknown as SupabaseClient<Database>;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const contacts = await loadHouseholdContacts(client, ["parent"]);
    expect(contacts.deliveryEmail("parent")).toBeNull();
    spy.mockRestore();
  });

  it("throws when the guardian links cannot be read", async () => {
    // Not a degradation. With no links every dependant looks like an account
    // holder with no address, which is a wrong answer rather than a missing one.
    const client = {
      from: () => ({
        select: () => ({ in: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
      }),
    } as unknown as SupabaseClient<Database>;
    await expect(loadHouseholdContacts(client, ["child"])).rejects.toThrow("boom");
  });
});

describe("contactUserIdOf", () => {
  it("resolves a dependant to their guardian and an account holder to themselves", async () => {
    const { client } = admin([PARENT, CHILD], [PARENT_EMAIL]);
    expect(await contactUserIdOf(client, "child")).toBe("parent");
    expect(await contactUserIdOf(client, "parent")).toBe("parent");
  });

  it("falls back to the person themselves when the read fails", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient<Database>;
    // Every caller is on a best-effort email path, and the right answer for
    // everybody who is not a dependant is themselves.
    expect(await contactUserIdOf(client, "parent")).toBe("parent");
  });
});

describe("deliveryEmailFor", () => {
  it("gives one person's delivery address through the guardian rule", async () => {
    const { client } = admin([PARENT, CHILD], [PARENT_EMAIL]);
    expect(await deliveryEmailFor(client, "child")).toBe("ada@example.com");
  });
});
