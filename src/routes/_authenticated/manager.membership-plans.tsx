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
import {
  planEditPayload,
  planEditsDiffer,
  type MembershipPlanKind,
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
const toCents = (dollars: string): number | null => {
  const t = dollars.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * What a plan is, in a manager's words. This one choice replaces both the old
 * "Kind" dropdown (which showed raw enum values like `period`) and the
 * separate "Runs" picker beside it. In practice the two always agreed, and
 * asking twice let them disagree.
 *
 * The selected option is the plan's stored `kind`. Deriving it from the date
 * fields instead — as the old "Runs" picker did — made two of its three
 * options unselectable: switching blanked the very fields the derivation read
 * back, so the choice snapped straight to "until credits run out" and the
 * dates could never be entered.
 *
 * `dates`/`duration`/`credits` drive which inputs show; `defaults` is applied
 * over the previous type's fields on switch, so a leftover date cannot linger
 * on a plan that runs on class credits.
 *
 * The database deliberately does NOT tie `kind` to the date columns (see
 * `savePlanSchema`), so the manager agent API can still write any
 * combination. Only this screen is opinionated, and a row that disagrees is
 * surfaced rather than silently dropped.
 */
type DurationFields = {
  starts_on: string | null;
  ends_on: string | null;
  duration_days: number | null;
};

type PlanTypeSpec = {
  label: string;
  blurb: string;
  dates: boolean;
  duration: boolean;
  credits: boolean;
  defaults: DurationFields;
};

const BLANK_DURATION: DurationFields = { starts_on: null, ends_on: null, duration_days: null };

/** Keyed by kind, so adding one to the enum fails the typecheck here rather
 * than silently rendering no option for it. Listed in display order. */
const PLAN_TYPES: Record<MembershipPlanKind, PlanTypeSpec> = {
  period: {
    label: "Training period",
    blurb: "Everyone who buys it trains between the same two dates.",
    dates: true,
    duration: false,
    credits: true,
    defaults: BLANK_DURATION,
  },
  insurance: {
    label: "Yearly insurance",
    blurb: "Runs a set number of days from the day they pay.",
    dates: false,
    duration: true,
    credits: false,
    defaults: { starts_on: null, ends_on: null, duration_days: 365 },
  },
  session: {
    label: "Casual class or class pack",
    blurb: "No end date. It ends when its classes run out.",
    dates: false,
    duration: false,
    credits: true,
    defaults: BLANK_DURATION,
  },
  trial: {
    label: "Free trial",
    blurb: "The free introductory classes. One per person.",
    dates: false,
    duration: false,
    credits: true,
    defaults: BLANK_DURATION,
  },
};

const PLAN_TYPE_KINDS = Object.keys(PLAN_TYPES) as MembershipPlanKind[];

/** Falls back to `period` so a row carrying an unexpected kind still renders
 * an editable card instead of crashing the whole screen. */
const planTypeOf = (kind: string): PlanTypeSpec =>
  PLAN_TYPES[kind as MembershipPlanKind] ?? PLAN_TYPES.period;

/** The full patch for switching a plan to `kind`: the new type's duration
 * defaults, plus clearing session credits when the new type has no use for
 * them (insurance never counts as mat time, so credits there are inert). */
function planTypePatch(kind: MembershipPlanKind) {
  const spec = PLAN_TYPES[kind];
  return {
    kind,
    ...spec.defaults,
    ...(spec.credits ? {} : { session_credits: null }),
  };
}

/** Duration values stored on a plan whose own type never reads them. Only
 * reachable for a row written by the manager agent API or by hand, but those
 * values would otherwise be invisible here and silently preserved on save. */
function strandedDurationFields(p: DurationFields & { kind: string }): string[] {
  const spec = planTypeOf(p.kind);
  const out: string[] = [];
  if (!spec.dates && (p.starts_on || p.ends_on)) out.push("start and end dates");
  if (!spec.duration && p.duration_days) out.push("days from payment");
  return out;
}

/**
 * A friendly pre-check mirroring `savePlanSchema`'s date refinements, so a
 * manager who fills in Starts and forgets Ends sees plain language instead of
 * a raw Zod issue array from the server. The type picker already makes the
 * dates/duration exclusion impossible to violate through the UI, so only the
 * "half-filled dates" and "end before start" cases can still happen here.
 */
function durationFieldsError(f: DurationFields & { kind: string }): string | null {
  const spec = planTypeOf(f.kind);
  if (spec.dates) {
    if (Boolean(f.starts_on) !== Boolean(f.ends_on)) {
      return "Set both a start and an end date, or neither.";
    }
    if (f.starts_on && f.ends_on && f.ends_on < f.starts_on) {
      return "End date must be on or after the start date.";
    }
  }
  // Without this a rolling plan would have no end at all: no dates to fall
  // off, and no day count to expire on.
  if (spec.duration && !f.duration_days) {
    return "Set how many days it runs from payment.";
  }
  return null;
}

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
  fields: DurationFields & { kind: string };
  onKindChange: (kind: MembershipPlanKind) => void;
  onFieldChange: (patch: Partial<DurationFields>) => void;
}) {
  const spec = planTypeOf(fields.kind);
  const stranded = strandedDurationFields(fields);
  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">What kind of plan is this?</Label>
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
      </div>
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
    <Card>
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
                placeholder="unlimited"
                value={plan.session_credits ?? ""}
                onChange={(e) => {
                  const n = e.target.value.trim();
                  onPatch(plan.id, { session_credits: n === "" ? null : Number(n) });
                }}
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
        <div className="flex gap-2">
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
    const durationError = durationFieldsError(plan);
    if (durationError) {
      toast.error(durationError);
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
    const durationError = durationFieldsError(newPlan);
    if (durationError) {
      toast.error(durationError);
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
      await fetchAll()
        .then((d) => {
          setPlans(d as MembershipPlanRow[]);
          setBaseline(baselineOf(d as MembershipPlanRow[]));
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
                    placeholder="unlimited"
                    value={newPlan.session_credits ?? ""}
                    onChange={(e) => {
                      const n = e.target.value.trim();
                      setNewPlan((s) => ({ ...s, session_credits: n === "" ? null : Number(n) }));
                    }}
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
