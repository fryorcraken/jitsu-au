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
import { membershipPlanKinds } from "@/lib/validation";
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

/**
 * A plan being created, before it has an id. Mirrors `MembershipPlanRow`'s
 * editable fields; `code` is blank until the manager types one (unlike
 * editing an existing plan, there is nothing to derive it from).
 */
type NewPlanForm = {
  code: string;
  name: string;
  description: string;
  kind: MembershipPlanRow["kind"];
  public_price_cents: number | null;
  student_price_cents: number | null;
  duration_days: number | null;
  session_credits: number | null;
  starts_on: string;
  ends_on: string;
  sort_order: number;
};

const emptyNewPlan = (): NewPlanForm => ({
  code: "",
  name: "",
  description: "",
  kind: "period",
  public_price_cents: null,
  student_price_cents: null,
  duration_days: null,
  session_credits: null,
  starts_on: "",
  ends_on: "",
  sort_order: 0,
});

function PlansPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchAll = useServerFn(listAllMembershipPlans);
  const save = useServerFn(saveMembershipPlan);

  const [plans, setPlans] = useState<MembershipPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newPlan, setNewPlan] = useState<NewPlanForm>(emptyNewPlan);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  function reload() {
    return fetchAll().then((data) => setPlans(data as MembershipPlanRow[]));
  }

  useEffect(() => {
    if (!isManager) return;
    fetchAll()
      .then((data) => setPlans(data as MembershipPlanRow[]))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load plans"))
      .finally(() => setLoading(false));
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
          kind: plan.kind as MembershipPlanRow["kind"],
          public_price_cents: plan.public_price_cents,
          student_price_cents: plan.student_price_cents,
          duration_days: plan.duration_days,
          session_credits: plan.session_credits,
          is_active: plan.is_active,
          sort_order: plan.sort_order,
          starts_on: plan.starts_on,
          ends_on: plan.ends_on,
        },
      });
      toast.success(`Saved ${plan.name}`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  }

  /** Fill the "Add a plan" form from an existing plan, so setting up next
   * year's is "duplicate, change the dates" rather than typing everything
   * again. Left blank: `code` (never a copy of another plan's) and the dates
   * (always the one thing that changes). */
  function duplicate(plan: MembershipPlanRow) {
    setNewPlan({
      code: "",
      name: plan.name,
      description: plan.description ?? "",
      kind: plan.kind as MembershipPlanRow["kind"],
      public_price_cents: plan.public_price_cents,
      student_price_cents: plan.student_price_cents,
      duration_days: null,
      session_credits: plan.session_credits,
      starts_on: "",
      ends_on: "",
      sort_order: plan.sort_order,
    });
    document.getElementById("add-plan-card")?.scrollIntoView({ behavior: "smooth" });
  }

  async function onCreate() {
    if (!newPlan.code.trim() || !newPlan.name.trim()) {
      toast.error("Give the plan a code and a name.");
      return;
    }
    if (newPlan.public_price_cents == null) {
      toast.error("Set a public price.");
      return;
    }
    setCreating(true);
    try {
      await save({
        data: {
          code: newPlan.code.trim(),
          name: newPlan.name.trim(),
          description: newPlan.description.trim(),
          kind: newPlan.kind,
          public_price_cents: newPlan.public_price_cents,
          student_price_cents: newPlan.student_price_cents,
          duration_days: newPlan.duration_days,
          session_credits: newPlan.session_credits,
          is_active: true,
          sort_order: newPlan.sort_order,
          starts_on: newPlan.starts_on || null,
          ends_on: newPlan.ends_on || null,
        },
      });
      toast.success("Plan added");
      setNewPlan(emptyNewPlan());
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the plan");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <>
        <div className="p-8">Loading...</div>
      </>
    );
  }

  // A dated plan whose window has finished is kept (its invoices still point
  // at it) but out of the manager's way, alongside anything a manager has
  // deactivated by hand.
  const today = new Date().toISOString().slice(0, 10);
  const isPast = (p: MembershipPlanRow) => Boolean(p.ends_on && p.ends_on < today);
  const current = plans.filter((p) => p.is_active && !isPast(p));
  const past = plans.filter((p) => !p.is_active || isPast(p));

  function PlanCard({ plan }: { plan: MembershipPlanRow }) {
    const hasDates = Boolean(plan.starts_on || plan.ends_on);
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-lg">{plan.name}</CardTitle>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={plan.is_active}
                onCheckedChange={(v) => patch(plan.id, { is_active: v === true })}
              />
              On sale
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
                onChange={(e) => patch(plan.id, { student_price_cents: toCents(e.target.value) })}
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
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label className="text-xs">Starts</Label>
              <Input
                type="date"
                value={plan.starts_on ?? ""}
                disabled={Boolean(plan.duration_days)}
                onChange={(e) => patch(plan.id, { starts_on: e.target.value || null })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Ends</Label>
              <Input
                type="date"
                value={plan.ends_on ?? ""}
                disabled={Boolean(plan.duration_days)}
                onChange={(e) => patch(plan.id, { ends_on: e.target.value || null })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Or: rolling days from payment</Label>
              <Input
                inputMode="numeric"
                placeholder="none"
                value={plan.duration_days ?? ""}
                disabled={hasDates}
                onChange={(e) => {
                  const n = e.target.value.trim();
                  patch(plan.id, { duration_days: n === "" ? null : Number(n) });
                }}
                className="mt-1"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            A plan runs between two dates (everyone who buys it gets exactly those dates), or for a
            number of days from payment (like yearly insurance) — never both. Leave all three blank
            for a plan that ends with its session credits instead (the free trial, casual classes).
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={savingId === plan.id} onClick={() => onSave(plan)}>
              {savingId === plan.id ? "Saving..." : "Save"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => duplicate(plan)}>
              Duplicate
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Plans</h1>
            <p className="text-sm text-muted-foreground">
              Edit prices, dates and availability. These drive the member signup — the public
              pricing page is written by hand and does not read this list.
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/manager/memberships">Back to memberships</Link>
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          {current.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>

        <Card id="add-plan-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Add a plan</CardTitle>
            <p className="text-xs text-muted-foreground">
              A new training period is a new plan, priced and dated on its own — not a second date
              range under an existing one. "Duplicate" on an existing plan above starts this form
              filled in.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Code</Label>
                <Input
                  placeholder="semester_2_2027"
                  value={newPlan.code}
                  onChange={(e) => setNewPlan((s) => ({ ...s, code: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="new-plan-kind" className="text-xs">
                  Kind
                </Label>
                <select
                  id="new-plan-kind"
                  value={newPlan.kind}
                  onChange={(e) =>
                    setNewPlan((s) => ({
                      ...s,
                      kind: e.target.value as MembershipPlanRow["kind"],
                    }))
                  }
                  className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                >
                  {membershipPlanKinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                placeholder="Semester 2 2027"
                value={newPlan.name}
                onChange={(e) => setNewPlan((s) => ({ ...s, name: e.target.value }))}
                maxLength={120}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Input
                value={newPlan.description}
                onChange={(e) => setNewPlan((s) => ({ ...s, description: e.target.value }))}
                maxLength={500}
                className="mt-1"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label className="text-xs">Public price ($)</Label>
                <Input
                  inputMode="decimal"
                  value={toDollars(newPlan.public_price_cents)}
                  onChange={(e) =>
                    setNewPlan((s) => ({ ...s, public_price_cents: toCents(e.target.value) }))
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Student price ($)</Label>
                <Input
                  inputMode="decimal"
                  placeholder="none"
                  value={toDollars(newPlan.student_price_cents)}
                  onChange={(e) =>
                    setNewPlan((s) => ({ ...s, student_price_cents: toCents(e.target.value) }))
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Session credits</Label>
                <Input
                  inputMode="numeric"
                  placeholder="none"
                  value={newPlan.session_credits ?? ""}
                  onChange={(e) => {
                    const n = e.target.value.trim();
                    setNewPlan((s) => ({ ...s, session_credits: n === "" ? null : Number(n) }));
                  }}
                  className="mt-1"
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label className="text-xs">Starts</Label>
                <Input
                  type="date"
                  value={newPlan.starts_on}
                  disabled={Boolean(newPlan.duration_days)}
                  onChange={(e) => setNewPlan((s) => ({ ...s, starts_on: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Ends</Label>
                <Input
                  type="date"
                  value={newPlan.ends_on}
                  disabled={Boolean(newPlan.duration_days)}
                  onChange={(e) => setNewPlan((s) => ({ ...s, ends_on: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Or: rolling days from payment</Label>
                <Input
                  inputMode="numeric"
                  placeholder="none"
                  value={newPlan.duration_days ?? ""}
                  disabled={Boolean(newPlan.starts_on || newPlan.ends_on)}
                  onChange={(e) => {
                    const n = e.target.value.trim();
                    setNewPlan((s) => ({ ...s, duration_days: n === "" ? null : Number(n) }));
                  }}
                  className="mt-1"
                />
              </div>
            </div>
            <Button size="sm" disabled={creating} onClick={onCreate}>
              {creating ? "Adding..." : "Add plan"}
            </Button>
          </CardContent>
        </Card>

        {past.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-xl font-bold text-muted-foreground">Past plans</h2>
            <div className="space-y-4">
              {past.map((plan) => (
                <PlanCard key={plan.id} plan={plan} />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
