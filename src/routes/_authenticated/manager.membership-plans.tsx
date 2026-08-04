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
import { membershipPlanKinds, type MembershipPlanKind, type SavePlanInput } from "@/lib/validation";
import { formatDateOnly } from "@/lib/dates";
import { CLUB_TIME_ZONE, clubLocalDate } from "@/lib/calendar";
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

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** The three mutually exclusive ways a plan can run, as an explicit choice
 * rather than three fields that grey each other out — a manager picks one,
 * and only its fields show. Switching modes blanks all three underlying
 * fields, since a leftover date or day-count from the previous mode has no
 * meaning once the mode has changed. */
type DurationMode = "dated" | "rolling" | "none";
type DurationFields = {
  starts_on: string | null;
  ends_on: string | null;
  duration_days: number | null;
};

function durationModeOf(p: DurationFields): DurationMode {
  if (p.starts_on || p.ends_on) return "dated";
  if (p.duration_days) return "rolling";
  return "none";
}

const BLANK_DURATION: DurationFields = { starts_on: null, ends_on: null, duration_days: null };

/**
 * A friendly pre-check mirroring `savePlanSchema`'s date refinements, so a
 * manager who fills in Starts and forgets Ends sees plain language instead of
 * a raw Zod issue array from the server. The mode picker below already makes
 * the dates/duration exclusion impossible to violate through the UI, so only
 * the "half-filled dates" and "end before start" cases can still happen here.
 */
function durationFieldsError(f: DurationFields): string | null {
  if (Boolean(f.starts_on) !== Boolean(f.ends_on)) {
    return "Set both a start and an end date, or neither.";
  }
  if (f.starts_on && f.ends_on && f.ends_on < f.starts_on) {
    return "End date must be on or after the start date.";
  }
  return null;
}

/** The Runs picker + its mode-specific fields, shared by an existing plan's
 * card and the "Add a plan" form so the two can never drift apart. */
function DurationModeFields({
  idPrefix,
  fields,
  onModeChange,
  onFieldChange,
}: {
  idPrefix: string;
  fields: DurationFields;
  onModeChange: (mode: DurationMode) => void;
  onFieldChange: (patch: Partial<DurationFields>) => void;
}) {
  const mode = durationModeOf(fields);
  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">Runs</Label>
        <div className="mt-1.5 space-y-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${idPrefix}-runs`}
              checked={mode === "dated"}
              onChange={() => onModeChange("dated")}
            />
            Between two dates
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${idPrefix}-runs`}
              checked={mode === "rolling"}
              onChange={() => onModeChange("rolling")}
            />
            For a number of days from payment
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${idPrefix}-runs`}
              checked={mode === "none"}
              onChange={() => onModeChange("none")}
            />
            Until its session credits run out
          </label>
        </div>
      </div>
      {mode === "dated" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${idPrefix}-starts`} className="text-xs">
              Starts
            </Label>
            <Input
              id={`${idPrefix}-starts`}
              type="date"
              value={fields.starts_on ?? ""}
              onChange={(e) => onFieldChange({ starts_on: e.target.value || null })}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-ends`} className="text-xs">
              Ends
            </Label>
            <Input
              id={`${idPrefix}-ends`}
              type="date"
              value={fields.ends_on ?? ""}
              onChange={(e) => onFieldChange({ ends_on: e.target.value || null })}
              className="mt-1"
            />
          </div>
        </div>
      )}
      {mode === "rolling" && (
        <div>
          <Label htmlFor={`${idPrefix}-duration`} className="text-xs">
            Days from payment
          </Label>
          <Input
            id={`${idPrefix}-duration`}
            inputMode="numeric"
            value={fields.duration_days ?? ""}
            onChange={(e) => {
              const n = e.target.value.trim();
              onFieldChange({ duration_days: n === "" ? null : Number(n) });
            }}
            className="mt-1 max-w-[10rem]"
          />
        </div>
      )}
    </div>
  );
}

/**
 * One plan's editable card. Hoisted to module scope and driven entirely by
 * props: an inline function component re-created on every render of the
 * parent (as this used to be) gets a new identity each time, so React
 * remounts the whole card on every keystroke — a manager could type exactly
 * one character before losing focus.
 */
function PlanCard({
  plan,
  savingId,
  onPatch,
  onSave,
  onDuplicate,
}: {
  plan: MembershipPlanRow;
  savingId: string | null;
  onPatch: (id: string, patch: Partial<MembershipPlanRow>) => void;
  onSave: (plan: MembershipPlanRow) => void;
  onDuplicate: (plan: MembershipPlanRow) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg">{plan.name}</CardTitle>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={plan.is_active}
              onCheckedChange={(v) => onPatch(plan.id, { is_active: v === true })}
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
            <Label htmlFor={`plan-${plan.id}-name`} className="text-xs">
              Name
            </Label>
            <Input
              id={`plan-${plan.id}-name`}
              value={plan.name}
              onChange={(e) => onPatch(plan.id, { name: e.target.value })}
              maxLength={120}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor={`plan-${plan.id}-description`} className="text-xs">
              Description
            </Label>
            <Input
              id={`plan-${plan.id}-description`}
              value={plan.description ?? ""}
              onChange={(e) => onPatch(plan.id, { description: e.target.value })}
              maxLength={500}
              className="mt-1"
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor={`plan-${plan.id}-public-price`} className="text-xs">
              Public price ($)
            </Label>
            <Input
              id={`plan-${plan.id}-public-price`}
              inputMode="decimal"
              value={toDollars(plan.public_price_cents)}
              onChange={(e) =>
                onPatch(plan.id, { public_price_cents: toCents(e.target.value) ?? 0 })
              }
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor={`plan-${plan.id}-student-price`} className="text-xs">
              Student price ($)
            </Label>
            <Input
              id={`plan-${plan.id}-student-price`}
              inputMode="decimal"
              placeholder="none"
              value={toDollars(plan.student_price_cents)}
              onChange={(e) => onPatch(plan.id, { student_price_cents: toCents(e.target.value) })}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor={`plan-${plan.id}-credits`} className="text-xs">
              Session credits
            </Label>
            <Input
              id={`plan-${plan.id}-credits`}
              inputMode="numeric"
              placeholder="none"
              value={plan.session_credits ?? ""}
              onChange={(e) => {
                const n = e.target.value.trim();
                onPatch(plan.id, { session_credits: n === "" ? null : Number(n) });
              }}
              className="mt-1"
            />
          </div>
        </div>
        <DurationModeFields
          idPrefix={`plan-${plan.id}`}
          fields={plan}
          onModeChange={() => onPatch(plan.id, BLANK_DURATION)}
          onFieldChange={(patch) => onPatch(plan.id, patch)}
        />
        <div className="flex gap-2">
          <Button size="sm" disabled={savingId === plan.id} onClick={() => onSave(plan)}>
            {savingId === plan.id ? "Saving..." : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDuplicate(plan)}>
            Duplicate
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** A plan no longer on sale, collapsed to one line (name + why) until opened —
 * a manager auditing years of retired plans should not face a wall of open
 * edit forms. */
function NotOnSaleRow({
  plan,
  ended,
  savingId,
  onPatch,
  onSave,
  onDuplicate,
}: {
  plan: MembershipPlanRow;
  ended: boolean;
  savingId: string | null;
  onPatch: (id: string, patch: Partial<MembershipPlanRow>) => void;
  onSave: (plan: MembershipPlanRow) => void;
  onDuplicate: (plan: MembershipPlanRow) => void;
}) {
  return (
    <details className="rounded-lg border bg-card">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm">
        <span className="font-medium">{plan.name}</span>
        <span className="text-xs text-muted-foreground">
          {ended ? `Ended ${formatDateOnly(plan.ends_on)}` : "Off sale"}
        </span>
      </summary>
      <div className="border-t p-4 pt-0">
        <div className="pt-4">
          <PlanCard
            plan={plan}
            savingId={savingId}
            onPatch={onPatch}
            onSave={onSave}
            onDuplicate={onDuplicate}
          />
        </div>
      </div>
    </details>
  );
}

/**
 * A plan being created, before it has an id. Mirrors `MembershipPlanRow`'s
 * editable fields; `code` is blank until the manager types one (unlike
 * editing an existing plan, there is nothing to derive it from).
 */
type NewPlanForm = {
  code: string;
  name: string;
  description: string;
  kind: MembershipPlanKind;
  public_price_cents: number | null;
  student_price_cents: number | null;
  duration_days: number | null;
  session_credits: number | null;
  starts_on: string | null;
  ends_on: string | null;
  sort_order: number;
  is_active: boolean;
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
  starts_on: null,
  ends_on: null,
  sort_order: 0,
  is_active: true,
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
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

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

  /** Save one plan and fold the confirmed row back into local state.
   * Deliberately NOT a full `reload()`: refetching every plan after one save
   * would throw away whatever another card had mid-edit but unsaved, since
   * every card shares the same `plans` array. */
  async function onSave(plan: MembershipPlanRow) {
    const durationError = durationFieldsError(plan);
    if (durationError) {
      toast.error(durationError);
      return;
    }
    setSavingId(plan.id);
    try {
      const data: SavePlanInput = {
        id: plan.id,
        code: plan.code,
        name: plan.name,
        description: plan.description || "",
        kind: plan.kind as MembershipPlanKind,
        public_price_cents: plan.public_price_cents,
        student_price_cents: plan.student_price_cents,
        duration_days: plan.duration_days,
        session_credits: plan.session_credits,
        is_active: plan.is_active,
        sort_order: plan.sort_order,
        starts_on: plan.starts_on,
        ends_on: plan.ends_on,
      };
      await save({ data });
      setPlans((prev) => prev.map((pl) => (pl.id === plan.id ? { ...pl, ...data } : pl)));
      toast.success(`Saved ${plan.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  }

  /** Fill the "Add a plan" form from an existing plan, so setting up next
   * year's is "duplicate, change the dates" rather than typing everything
   * again. Left blank: `code` (never a copy of another plan's) and the dates
   * (always the one thing that changes) — but a rolling plan's `duration_days`
   * carries over unchanged, since that number usually doesn't change year to
   * year (e.g. yearly insurance is still 365 days). */
  function duplicate(plan: MembershipPlanRow) {
    setNewPlan({
      code: "",
      name: plan.name,
      description: plan.description ?? "",
      kind: plan.kind as MembershipPlanKind,
      public_price_cents: plan.public_price_cents,
      student_price_cents: plan.student_price_cents,
      duration_days: plan.duration_days,
      session_credits: plan.session_credits,
      starts_on: null,
      ends_on: null,
      sort_order: plan.sort_order,
      is_active: true,
    });
    setCopiedFrom(plan.name);
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
    const durationError = durationFieldsError(newPlan);
    if (durationError) {
      toast.error(durationError);
      return;
    }
    setCreating(true);
    try {
      const data: SavePlanInput = {
        code: newPlan.code.trim(),
        name: newPlan.name.trim(),
        description: newPlan.description.trim(),
        kind: newPlan.kind,
        public_price_cents: newPlan.public_price_cents,
        student_price_cents: newPlan.student_price_cents,
        duration_days: newPlan.duration_days,
        session_credits: newPlan.session_credits,
        is_active: newPlan.is_active,
        sort_order: newPlan.sort_order,
        starts_on: newPlan.starts_on,
        ends_on: newPlan.ends_on,
      };
      await save({ data });
      toast.success("Plan added");
      setNewPlan(emptyNewPlan());
      setCopiedFrom(null);
      await fetchAll()
        .then((d) => setPlans(d as MembershipPlanRow[]))
        .catch(() => {});
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

  // Club-local, not UTC: the member purchase screen's `sellablePlans` decides
  // a dated plan has ended by the same club-local calendar day, so the two
  // screens agree right up to the day's boundary rather than for 11 hours a
  // day disagreeing across UTC midnight.
  const today = clubLocalDate(new Date(), CLUB_TIME_ZONE);
  const isEnded = (p: MembershipPlanRow) => Boolean(p.ends_on && p.ends_on < today);
  const current = plans.filter((p) => p.is_active && !isEnded(p));
  const notOnSale = plans.filter((p) => !p.is_active || isEnded(p));

  return (
    <>
      <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Plans</h1>
            <p className="text-sm text-muted-foreground">
              Edit prices, dates and availability. These drive the member signup, and the public
              pricing page is written by hand and does not read this list.
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/manager/memberships">Back to memberships</Link>
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          A plan runs between two dates (everyone who buys it gets exactly those dates), for a
          number of days from payment (like yearly insurance), or until its session credits run out
          instead of on a date (the free trial, casual classes). Never more than one at once.
        </p>

        <div className="space-y-4">
          {current.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              savingId={savingId}
              onPatch={patch}
              onSave={onSave}
              onDuplicate={duplicate}
            />
          ))}
        </div>

        <Card id="add-plan-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Add a plan</CardTitle>
            <p className="text-xs text-muted-foreground">
              A new training period is a new plan, priced and dated on its own, not a second date
              range under an existing one. "Duplicate" on an existing plan above starts this form
              filled in.
            </p>
            {copiedFrom && (
              <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-xs">
                <span>
                  Copied from <span className="font-medium">{copiedFrom}</span>. This creates a new
                  plan, so set its code and dates below.
                </span>
                <button
                  type="button"
                  className="shrink-0 underline hover:no-underline"
                  onClick={() => {
                    setNewPlan(emptyNewPlan());
                    setCopiedFrom(null);
                  }}
                >
                  Clear
                </button>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="new-plan-code" className="text-xs">
                  Code
                </Label>
                <Input
                  id="new-plan-code"
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
                      kind: e.target.value as MembershipPlanKind,
                    }))
                  }
                  className={`mt-1 w-full ${selectClass}`}
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
              <Label htmlFor="new-plan-name" className="text-xs">
                Name
              </Label>
              <Input
                id="new-plan-name"
                placeholder="Semester 2 2027"
                value={newPlan.name}
                onChange={(e) => setNewPlan((s) => ({ ...s, name: e.target.value }))}
                maxLength={120}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="new-plan-description" className="text-xs">
                Description
              </Label>
              <Input
                id="new-plan-description"
                value={newPlan.description}
                onChange={(e) => setNewPlan((s) => ({ ...s, description: e.target.value }))}
                maxLength={500}
                className="mt-1"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="new-plan-public-price" className="text-xs">
                  Public price ($)
                </Label>
                <Input
                  id="new-plan-public-price"
                  inputMode="decimal"
                  value={toDollars(newPlan.public_price_cents)}
                  onChange={(e) =>
                    setNewPlan((s) => ({ ...s, public_price_cents: toCents(e.target.value) }))
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="new-plan-student-price" className="text-xs">
                  Student price ($)
                </Label>
                <Input
                  id="new-plan-student-price"
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
                <Label htmlFor="new-plan-credits" className="text-xs">
                  Session credits
                </Label>
                <Input
                  id="new-plan-credits"
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
            <DurationModeFields
              idPrefix="new-plan"
              fields={newPlan}
              onModeChange={() => setNewPlan((s) => ({ ...s, ...BLANK_DURATION }))}
              onFieldChange={(p) => setNewPlan((s) => ({ ...s, ...p }))}
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={newPlan.is_active}
                onCheckedChange={(v) => setNewPlan((s) => ({ ...s, is_active: v === true }))}
              />
              On sale immediately
            </label>
            <Button size="sm" disabled={creating} onClick={onCreate}>
              {creating ? "Adding..." : "Add plan"}
            </Button>
          </CardContent>
        </Card>

        {notOnSale.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-xl font-bold text-muted-foreground">Not on sale</h2>
            <div className="space-y-2">
              {notOnSale.map((plan) => (
                <NotOnSaleRow
                  key={plan.id}
                  plan={plan}
                  ended={isEnded(plan)}
                  savingId={savingId}
                  onPatch={patch}
                  onSave={onSave}
                  onDuplicate={duplicate}
                />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
