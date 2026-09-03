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
 * `fallback` does two jobs, and the default has to survive both: it labels a
 * nameless row's plain text AND becomes the whole accessible name of a nameless
 * row that still has a record to open. That rules out the placeholder dash the
 * rest of a table uses for an empty cell — "link, —" tells a screen-reader user
 * nothing about where it goes — and equally rules out an action word like
 * "View", which reads as a broken button on the row with nothing to open. A
 * word that stands in for the person works in both: it names the link, and it
 * says plainly that the name is missing.
 *
 * `py-1 -my-1` grows the tap target without moving anything on screen: the
 * padding enlarges it, the negative margin gives the space back to the layout.
 * Two of these sit in `text-xs` rows, where the text line alone is a ~16px
 * target on the phone most of this club's admin happens on. It buys 24px, which
 * clears WCAG 2.5.8 AA rather than being genuinely thumb-sized.
 */
export function UserLink({
  userId,
  name,
  fallback = "Unknown",
}: {
  userId: string | null | undefined;
  name: string | null | undefined;
  /**
   * Stands in for a row that carries no name, as text or as the link's
   * accessible name. Override it only with another word for the person
   * ("Someone at the club"), never with a placeholder or an action.
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
