import { Link } from "@tanstack/react-router";

/**
 * A person's name in a manager's list, as the way in to their record.
 *
 * Every manager table shows names for the same reason: the name is the row a
 * manager wants to open. Before this existed each table decided that for
 * itself, so half of them linked and half printed the name as dead text, and a
 * manager looking at a signed waiver had to go back to the directory and search
 * for the same person by hand.
 *
 * The underline is permanent rather than on hover. Most of this club's admin
 * happens on a phone between classes, where there is no hover, so a link that
 * only reveals itself to a mouse is a link nobody can see.
 *
 * Not every row has a person behind it: an interest registration is a lead with
 * no account yet, and a membership can outlive the account it was raised for.
 * Those render as plain text, because a link to a page that does not exist is
 * worse than no link.
 *
 * `fallback` is what a row with no name shows, and on a row that DOES have a
 * record it becomes the link's whole accessible name — so it has to read as
 * something openable ("View", "Unknown"), never as a bare placeholder. A link
 * announced to a screen reader as "link, —" says nothing about where it goes,
 * which is why the default is only ever reached by a row with nothing to open.
 *
 * `py-1 -my-1` buys a thumb-sized hit area without moving anything on screen:
 * the padding grows the target, the negative margin gives the space back to the
 * layout. Two of these sit in `text-xs` rows, where the text line alone is a
 * ~16px target on the phone most of this club's admin happens on.
 */
export function UserLink({
  userId,
  name,
  fallback = "—",
}: {
  userId: string | null | undefined;
  name: string | null | undefined;
  /**
   * What to show when the row carries no name. Doubles as the link's accessible
   * name when there is still a record to open, so word it accordingly.
   */
  fallback?: string;
}) {
  const label = name?.trim() ? name : fallback;
  if (!userId) return <>{label}</>;
  return (
    <Link
      to="/manager/users/$userId"
      params={{ userId }}
      className="inline-block py-1 -my-1 underline underline-offset-2 hover:no-underline"
    >
      {label}
    </Link>
  );
}
