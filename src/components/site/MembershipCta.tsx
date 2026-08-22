import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

/**
 * The pricing page's "so how do I actually pay?" call to action.
 *
 * It has to know who is reading, because only one of the two audiences can use
 * /membership. That page sits behind the auth gate, and this site has no
 * self-serve sign-up: a login only exists once a manager has approved your
 * waiver. So an unconditional link to it walked a prospective member into a
 * sign-in box with nothing to do in it, where the one available action asks
 * for an email that will never get a link (issue #58). Someone who has just
 * read the prices and decided is the worst person on the site to dead-end.
 *
 * While the session is still resolving we render the signed-out branch rather
 * than a spinner or an empty slot. It is what the server renders anyway, it is
 * right for the large majority of people reading a public pricing page, and it
 * always leaves something on screen to press. SiteHeader treats "not known
 * yet" the same way, so the two agree.
 */
export function MembershipCta() {
  const { user } = useAuth();

  if (user) {
    return (
      <Button asChild variant="outline">
        <Link to="/membership">Manage your membership</Link>
      </Button>
    );
  }

  return (
    <div>
      <Button asChild variant="outline">
        <Link to="/register-interest">Join the club</Link>
      </Button>
      <p className="mt-3 max-w-prose text-sm text-muted-foreground">
        Joining starts with two free sessions, so there's nothing to pay yet. Already have a login?{" "}
        <Link
          to="/auth"
          search={{ redirect: "/membership" }}
          className="font-semibold text-primary underline"
        >
          Sign in
        </Link>{" "}
        to buy or renew your membership.
      </p>
    </div>
  );
}
