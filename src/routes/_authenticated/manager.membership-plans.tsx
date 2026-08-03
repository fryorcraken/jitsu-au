import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listAllMembershipPlans, saveMembershipPlan } from "@/lib/membership.functions";
import { MembershipWindowsEditor } from "@/components/manager/MembershipWindowsEditor";
import type { MembershipPlanRow } from "@/lib/membership-types";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/membership-plans")({
  head: () => ({
    meta: [{ title: "Membership plans | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: PlansPage,
});

/** Cents <-> dollar-string helpers for the price inputs. */
const toDollars = (cents: number | null) => (cents == null ? "" : String(cents / 100));
const toCents = (dollars: string): number | null => {
  const t = dollars.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

function PlansPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchAll = useServerFn(listAllMembershipPlans);
  const save = useServerFn(saveMembershipPlan);

  const [plans, setPlans] = useState<MembershipPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchAll()
      .then((data) => {
        setPlans(data as MembershipPlanRow[]);
        setLoading(false);
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Failed to load plans");
        setLoading(false);
      });
  }, [isManager, fetchAll]);

  function patch(id: string, p: Partial<MembershipPlanRow>) {
    setPlans((prev) => prev.map((pl) => (pl.id === id ? { ...pl, ...p } : pl)));
  }

  async function onSave(plan: MembershipPlanRow) {
    setSavingId(plan.id);
    try {
      await save({
        data: {
          id: plan.id,
          code: plan.code,
          name: plan.name,
          description: plan.description || "",
          kind: plan.kind,
          public_price_cents: plan.public_price_cents,
          student_price_cents: plan.student_price_cents,
          session_credits: plan.session_credits,
          is_active: plan.is_active,
          sort_order: plan.sort_order,
        },
      });
      toast.success(`Saved ${plan.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <>
        <div className="p-8">Loading...</div>
      </>
    );
  }

  return (
    <>
      <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Membership plans</h1>
            <p className="text-sm text-muted-foreground">
              Edit prices and availability. These drive the pricing page and the member signup.
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/manager/memberships">Back to memberships</Link>
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          {plans.map((plan) => (
            <Card key={plan.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-lg">{plan.name}</CardTitle>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={plan.is_active}
                      onCheckedChange={(v) => patch(plan.id, { is_active: v === true })}
                    />
                    Active
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  <code>{plan.code}</code> · {plan.kind}
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={plan.name}
                      onChange={(e) => patch(plan.id, { name: e.target.value })}
                      maxLength={120}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={plan.description ?? ""}
                      onChange={(e) => patch(plan.id, { description: e.target.value })}
                      maxLength={500}
                      className="mt-1"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs">Public price ($)</Label>
                    <Input
                      inputMode="decimal"
                      value={toDollars(plan.public_price_cents)}
                      onChange={(e) =>
                        patch(plan.id, { public_price_cents: toCents(e.target.value) ?? 0 })
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Student price ($)</Label>
                    <Input
                      inputMode="decimal"
                      placeholder="none"
                      value={toDollars(plan.student_price_cents)}
                      onChange={(e) =>
                        patch(plan.id, { student_price_cents: toCents(e.target.value) })
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Session credits</Label>
                    <Input
                      inputMode="numeric"
                      placeholder="none"
                      value={plan.session_credits ?? ""}
                      onChange={(e) => {
                        const n = e.target.value.trim();
                        patch(plan.id, { session_credits: n === "" ? null : Number(n) });
                      }}
                      className="mt-1"
                    />
                  </div>
                </div>
                <Button size="sm" disabled={savingId === plan.id} onClick={() => onSave(plan)}>
                  {savingId === plan.id ? "Saving..." : "Save"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        {plans.some((p) => p.kind === "period") && (
          <div className="space-y-3">
            <div>
              <h2 className="text-2xl font-bold">Membership windows</h2>
              <p className="text-sm text-muted-foreground">
                The dates a `period` membership runs for. Members pick the current or next window
                when they join.
              </p>
            </div>
            <MembershipWindowsEditor />
          </div>
        )}
      </section>
    </>
  );
}
