import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { managerNotifications } from "@/lib/manager-notifications.functions";
import type { ManagerNotification } from "@/lib/validation";
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
  const fetchNotifications = useServerFn(managerNotifications);

  const [notifications, setNotifications] = useState<ManagerNotification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchNotifications()
      .then((data) => {
        setNotifications(data);
        setLoading(false);
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Failed to load notifications");
        setLoading(false);
      });
  }, [isManager, fetchNotifications]);

  return (
    <>
      <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-3xl font-black">Manager dashboard</h1>
          <p className="text-sm text-muted-foreground">
            What needs attention, and where to go to do it.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BellRing className="h-5 w-5" />
              Needs attention
            </CardTitle>
            <CardDescription>Things only a manager can fix.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {!loading && notifications.length === 0 && (
              <p className="text-sm text-muted-foreground">All quiet. Nothing needs doing.</p>
            )}
            <div className="space-y-3">
              {notifications.map((n, i) => (
                <div
                  key={`${n.type}-${i}`}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-4"
                >
                  <div>
                    <p className="font-medium">{n.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{n.body}</p>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link to={n.href}>{n.actionLabel}</Link>
                  </Button>
                </div>
              ))}
            </div>
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
