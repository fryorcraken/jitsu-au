import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/")({
  head: () => ({
    meta: [{ title: "Manager dashboard | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ManagerDashboard,
});

function ManagerDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  return (
    <>
      <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-3xl font-black">Manager dashboard</h1>
          <p className="text-sm text-muted-foreground">
            What needs attention, and where to go to do it.
          </p>
        </div>

        {/* The attention list itself now lives on /notifications, alongside
            comment activity, so a manager has one queue rather than two. This
            card is the signpost to it and deliberately keeps no copy of the
            items: two places rendering the same list is how they drift. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BellRing className="h-5 w-5" />
              Needs attention
            </CardTitle>
            <CardDescription>
              Things only a manager can fix, plus new comments, all on one page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/notifications">Open notifications</Link>
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { to: "/manager/check-in", title: "Check in", blurb: "Tonight's class at the door." },
            {
              to: "/manager/reconciliation",
              title: "Bank reconciliation",
              blurb: "Match payments to memberships.",
            },
            {
              to: "/manager/memberships",
              title: "Memberships",
              blurb: "Invoices, statuses and corrections.",
            },
            {
              to: "/manager/membership-plans",
              title: "Membership plans",
              blurb: "Prices, dates and availability.",
            },
            { to: "/manager/users", title: "Users", blurb: "Everyone in the funnel." },
            { to: "/manager/waivers", title: "Signed waivers", blurb: "Approvals and uploads." },
            {
              to: "/manager/contact-messages",
              title: "Contact messages",
              blurb: "What people sent through the form.",
            },
          ].map((item) => (
            <Link key={item.to} to={item.to}>
              <Card className="h-full transition-colors hover:bg-accent/50">
                <CardHeader>
                  <CardTitle className="text-base">{item.title}</CardTitle>
                  <CardDescription>{item.blurb}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
