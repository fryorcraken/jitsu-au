import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LoadingPanel } from "@/components/site/LoadingPanel";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listAllMembershipPlans, saveMembershipPlan } from "@/lib/membership.functions";
import {
  PLAN_TYPE_KINDS,
  PLAN_TYPES,
  planEditPayload,
  planEditsDiffer,
  planShapeError,
  planShapeUnchanged,
  planTypeOf,
  planTypePatch,
  strandedPlanFields,
  type MembershipPlanKind,
  type PlanShapeFields,
  type SavePlanInput,
} from "@/lib/validation";
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
/** Whole-number inputs (session credits, days from payment). A bare
 * `Number()` yields NaN on a typo like "1e", which `JSON.stringify` then puts
 * on the wire as `null` — silently wiping a stored value. Unparseable input
 * reads as blank instead. */
const toCount = (raw: string): number | null => {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const toCents = (dollars: string): number | null => {
  const t = dollars.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** The plan-type picker and whichever duration fields that type uses, shared
 * by an existing plan's card and the "Add a plan" form so the two can never
 * drift apart. */
function PlanTypeFields({
  idPrefix,
  fields,
  onKindChange,
  onFieldChange,
}: {
  idPrefix: string;
  fields: PlanShapeFields;
  onKindChange: (kind: MembershipPlanKind) => void;
  /** Never carries `kind` — only the type picker changes that, via
   * `onKindChange`, which also applies the new kind's defaults. */
  onFieldChange: (patch: Partial<Omit<PlanShapeFields, "kind">>) => void;
}) {
  const spec = planTypeOf(fields.kind);
  const stranded = strandedPlanFields(fields);
  return (
    <div className="space-y-3">
      {/* A real fieldset/legend, so a screen reader announces the four radios
          as one named group rather than four unlabelled controls. */}
      <fieldset>
        <legend className="text-xs font-medium">What kind of plan is this?</legend>
        <div className="mt-1.5 space-y-2">
          {PLAN_TYPE_KINDS.map((kind) => (
            <label key={kind} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                className="mt-1"
                name={`${idPrefix}-plan-type`}
                checked={fields.kind === kind}
                onChange={() => onKindChange(kind)}
              />
              <span>
                {PLAN_TYPES[kind].label}
                <span className="block text-xs text-muted-foreground">
                  {PLAN_TYPES[kind].blurb}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {stranded.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          This plan also has {stranded.join(" and ")} stored, which a {spec.label.toLowerCase()}{" "}
          plan ignores.{" "}
          <button
            type="button"
            className="underline hover:no-underline"
            onClick={() =>
              onFieldChange({
                ...(spec.dates ? {} : { starts_on: null, ends_on: null }),
                ...(spec.duration ? {} : { duration_days: null }),
                ...(spec.credits ? {} : { session_credits: null }),
              })
            }
          >
            Clear them
          </button>
        </p>
      )}
      {spec.dates && (
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
      {spec.duration && (
        <div>
          <Label htmlFor={`${idPrefix}-duration`} className="text-xs">
            Days from payment
          </Label>
          <Input
            id={`${idPrefix}-duration`}
            inputMode="numeric"
            value={fields.duration_days ?? ""}
            onChange={(e) => onFieldChange({ duration_days: toCount(e.target.value) })}
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
  ended = false,
  dirty,
  savingId,
  onPatch,
  onSave,
  onDuplicate,
}: {
  plan: MembershipPlanRow;
  /** Its end date has passed, so the site refuses to sell it whatever the
   * "Available to buy" tick says. Explained on the card, because a ticked box
   * under a "Not on sale" heading otherwise reads as a contradiction. */
  ended?: boolean;
  dirty: boolean;
  savingId: string | null;
  onPatch: (id: string, patch: Partial<MembershipPlanRow>) => void;
  onSave: (plan: MembershipPlanRow) => void;
  onDuplicate: (plan: MembershipPlanRow) => void;
}) {
  const spec = planTypeOf(plan.kind);
  return (
    // `data-plan` scopes a card's own controls: every card renders the same
    // labels, so tests (and anyone inspecting the DOM) need a stable handle
    // that does not depend on styling classes or DOM order.
    <Card data-plan={plan.id}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg">{plan.name}</CardTitle>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={plan.is_active}
              onCheckedChange={(v) => onPatch(plan.id, { is_active: v === true })}
            />
            Available to buy
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          <code>{plan.code}</code> · {spec.label}
        </p>
        {ended && (
          <p className="text-xs text-muted-foreground">
            Ended {formatDateOnly(plan.ends_on)}, so it is not for sale whatever this is set to.
          </p>
        )}
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
        <div className={`grid gap-3 ${spec.credits ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
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
          {spec.credits && (
            <div>
              <Label htmlFor={`plan-${plan.id}-credits`} className="text-xs">
                Session credits
              </Label>
              <Input
                id={`plan-${plan.id}-credits`}
                inputMode="numeric"
                // Blank means "unlimited" only when the dates still bound it.
                // For a credit-run plan a blank never runs out AND covers no
                // class, so it must not be advertised as unlimited.
                placeholder={spec.creditsRequired ? "how many classes" : "unlimited"}
                value={plan.session_credits ?? ""}
                onChange={(e) => onPatch(plan.id, { session_credits: toCount(e.target.value) })}
                className="mt-1"
              />
            </div>
          )}
        </div>
        <PlanTypeFields
          idPrefix={`plan-${plan.id}`}
          fields={plan}
          onKindChange={(kind) => onPatch(plan.id, planTypePatch(kind))}
          onFieldChange={(patch) => onPatch(plan.id, patch)}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!dirty || savingId === plan.id} onClick={() => onSave(plan)}>
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
  dirty,
  savingId,
  onPatch,
  onSave,
  onDuplicate,
}: {
  plan: MembershipPlanRow;
  ended: boolean;
  dirty: boolean;
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
            ended={ended}
            dirty={dirty}
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

const baselineOf = (rows: MembershipPlanRow[]): Record<string, MembershipPlanRow> =>
  Object.fromEntries(rows.map((r) => [r.id, r]));

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
  /** The last-saved copy of each plan, keyed by id, so a card can tell whether
   * it still matches the database and grey its Save button out when it does. */
  const [baseline, setBaseline] = useState<Record<string, MembershipPlanRow>>({});
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
      .then((data) => {
        setPlans(data as MembershipPlanRow[]);
        setBaseline(baselineOf(data as MembershipPlanRow[]));
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load plans"))
      .finally(() => setLoading(false));
  }, [isManager, fetchAll]);

  function patch(id: string, p: Partial<MembershipPlanRow>) {
    setPlans((prev) => prev.map((pl) => (pl.id === id ? { ...pl, ...p } : pl)));
  }

  /** A plan with no baseline yet (only possible mid-load) counts as dirty, so
   * a transient gap can never leave a manager unable to save real edits. */
  function isDirty(plan: MembershipPlanRow) {
    const saved = baseline[plan.id];
    return !saved || planEditsDiffer(plan, saved);
  }

  /** Save one plan and fold the confirmed row back into local state.
   * Deliberately NOT a full `reload()`: refetching every plan after one save
   * would throw away whatever another card had mid-edit but unsaved, since
   * every card shares the same `plans` array. */
  async function onSave(plan: MembershipPlanRow) {
    // Only hold a manager to the shape rules for a shape they are actually
    // changing. A row that arrived malformed (written by the manager agent
    // API, or predating these rules) must stay renameable and, above all,
    // takeable off sale — refusing the one edit that retires it would trap
    // them into fixing it first.
    const stored = baseline[plan.id];
    const shapeError = planShapeError(plan);
    if (shapeError && !(stored && planShapeUnchanged(plan, stored))) {
      toast.error(shapeError);
      return;
    }
    setSavingId(plan.id);
    try {
      const data: SavePlanInput = planEditPayload(plan);
      await save({ data });
      const saved = { ...plan, ...data };
      setPlans((prev) => prev.map((pl) => (pl.id === plan.id ? saved : pl)));
      // Re-baseline off the same object the list now holds, so the card goes
      // straight back to "no unsaved changes" and Save greys out again.
      setBaseline((prev) => ({ ...prev, [plan.id]: saved }));
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
    const publicPrice = newPlan.public_price_cents;
    if (publicPrice == null) {
      toast.error("Set a public price.");
      return;
    }
    const shapeError = planShapeError(newPlan);
    if (shapeError) {
      toast.error(shapeError);
      return;
    }
    setCreating(true);
    try {
      const data: SavePlanInput = planEditPayload({
        ...newPlan,
        code: newPlan.code.trim(),
        name: newPlan.name.trim(),
        description: newPlan.description.trim(),
        public_price_cents: publicPrice,
      });
      await save({ data });
      toast.success("Plan added");
      setNewPlan(emptyNewPlan());
      setCopiedFrom(null);
      // Refetch to pick up the new row, but keep any card the manager has
      // edited and not yet saved. Overwriting those would discard their work,
      // and re-baselining them would grey Save out afterwards, leaving a card
      // that looks saved while actually holding the server's values.
      const unsaved = new Map(plans.filter(isDirty).map((p) => [p.id, p]));
      await fetchAll()
        .then((d) => {
          const fresh = d as MembershipPlanRow[];
          setPlans(fresh.map((row) => unsaved.get(row.id) ?? row));
          setBaseline((prev) =>
            Object.fromEntries(
              fresh.map((row) => [row.id, unsaved.has(row.id) ? (prev[row.id] ?? row) : row]),
            ),
          );
        })
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
        <LoadingPanel />
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
            <h1 className="text-3xl font-black">Membership plans</h1>
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
          Every plan is one of four kinds, and the kind decides how it ends: a training period runs
          between two dates, yearly insurance runs a set number of days from payment, and a casual
          class or free trial runs until its classes are used up.
        </p>

        <div className="space-y-4">
          {current.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              dirty={isDirty(plan)}
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
            <div
              className={`grid gap-3 ${
                planTypeOf(newPlan.kind).credits ? "sm:grid-cols-3" : "sm:grid-cols-2"
              }`}
            >
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
              {planTypeOf(newPlan.kind).credits && (
                <div>
                  <Label htmlFor="new-plan-credits" className="text-xs">
                    Session credits
                  </Label>
                  <Input
                    id="new-plan-credits"
                    inputMode="numeric"
                    placeholder={
                      planTypeOf(newPlan.kind).creditsRequired ? "how many classes" : "unlimited"
                    }
                    value={newPlan.session_credits ?? ""}
                    onChange={(e) =>
                      setNewPlan((s) => ({ ...s, session_credits: toCount(e.target.value) }))
                    }
                    className="mt-1"
                  />
                </div>
              )}
            </div>
            <PlanTypeFields
              idPrefix="new-plan"
              fields={newPlan}
              onKindChange={(kind) => setNewPlan((s) => ({ ...s, ...planTypePatch(kind) }))}
              onFieldChange={(p) => setNewPlan((s) => ({ ...s, ...p }))}
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={newPlan.is_active}
                onCheckedChange={(v) => setNewPlan((s) => ({ ...s, is_active: v === true }))}
              />
              Available to buy immediately
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
                  dirty={isDirty(plan)}
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
