import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

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
 */
export function UserLink({
  userId,
  name,
  fallback = "—",
  className,
}: {
  userId: string | null | undefined;
  name: string | null | undefined;
  /** What to show when the row carries no name. */
  fallback?: string;
  className?: string;
}) {
  const label = name?.trim() ? name : fallback;
  if (!userId) return <>{label}</>;
  return (
    <Link
      to="/manager/users/$userId"
      params={{ userId }}
      className={cn("underline underline-offset-2 hover:no-underline", className)}
    >
      {label}
    </Link>
  );
}
