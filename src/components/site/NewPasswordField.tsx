import { Check, Circle, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PasswordInput } from "@/components/site/PasswordInput";
import { Label } from "@/components/ui/label";
import {
  checkPassword,
  hasVariety,
  meetsLength,
  PASSWORD_MIN_LENGTH,
  type BreachStatus,
  type PasswordRuleState,
} from "@/lib/password-policy";
import { lookupBreachedPassword } from "@/lib/pwned-passwords";
import { cn } from "@/lib/utils";

/** How long to sit still before asking HIBP, so a lookup is not fired per keystroke. */
const LOOKUP_DELAY_MS = 500;

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * What the club knows about this person: their email address, their name.
   * The rules use it to refuse a password built out of it.
   */
  personal?: (string | null | undefined)[];
  /**
   * Told how the breach lookup is going, so the form can refuse to submit a
   * password this field is showing a red cross against.
   */
  onBreachChange?: (status: BreachStatus) => void;
  autoFocus?: boolean;
  disabled?: boolean;
};

/**
 * The field for choosing a new password, with the rules on screen next to it.
 *
 * The rules are listed before anything is typed, not produced as a rejection
 * afterwards, because being told "that one is weak" by a form that never said
 * what it wanted is the whole problem this replaces. Each rule ticks off as it
 * is met, including the breach check, which runs while you type rather than at
 * submit.
 *
 * The rules themselves, and why they are these rules, live in
 * `@/lib/password-policy`.
 */
export function NewPasswordField({
  id,
  label,
  value,
  onChange,
  personal,
  onBreachChange,
  autoFocus,
  disabled,
}: Props) {
  const [breach, setBreach] = useState<BreachStatus>("idle");

  // Held in a ref so the report below fires when the STATUS changes and not
  // whenever the parent happens to re-render with a fresh arrow function.
  const report = useRef(onBreachChange);
  report.current = onBreachChange;
  useEffect(() => {
    report.current?.(breach);
  }, [breach]);

  // Only ask about a password that has already cleared the rules we can check
  // ourselves. A half-typed one is not worth a request, and its answer would be
  // stale by the next keystroke anyway.
  const worthChecking = meetsLength(value) && hasVariety(value);

  useEffect(() => {
    if (!worthChecking) {
      setBreach("idle");
      return;
    }
    setBreach("checking");
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      lookupBreachedPassword(value, controller.signal).then((result) => {
        if (!cancelled) setBreach(result);
      });
    }, LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, worthChecking]);

  const rules = checkPassword(value, { personal, breach });
  const touched = value.length > 0;
  const met = rules.filter((rule) => rule.state === "met").length;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <PasswordInput
        id={id}
        required
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="new-password"
        aria-describedby={`${id}-hint ${id}-rules`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        Length is what makes a password hard to guess, not punctuation. Four unrelated words you can
        picture are easier to type on a phone than a short one full of symbols, and far harder to
        break.
      </p>
      <ul id={`${id}-rules`} className="space-y-1 text-sm">
        {rules.map((rule) => {
          const shown = displayState(rule.state, touched, breach);
          return (
            <li key={rule.id} className="flex items-start gap-2">
              <RuleIcon state={shown} />
              <span
                className={cn(
                  shown === "met" && "text-green-700",
                  shown === "unmet" && "text-destructive",
                  (shown === "idle" || shown === "pending") && "text-muted-foreground",
                )}
              >
                {rule.label}
                <span className="sr-only">{RULE_STATE_WORDING[shown]}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="sr-only" role="status">
        {touched ? `${met} of ${rules.length} password requirements met.` : ""}
      </p>
    </div>
  );
}

/** A rule as the row shows it. `idle` is "nothing to say about this yet". */
type ShownState = PasswordRuleState | "idle";

const RULE_STATE_WORDING: Record<ShownState, string> = {
  idle: "",
  met: ", met",
  pending: ", checking",
  unmet: ", not met yet",
};

/**
 * What a row shows, which is not quite the rule's own state.
 *
 * Two rules only, both about not accusing anybody of anything prematurely.
 * Before a single character is typed, four red crosses read as a telling-off,
 * so nothing has a verdict yet. And the breach rule sits at `pending` both
 * while a lookup is in flight and before the password is even long enough to
 * be worth one: a spinner is a promise that something is happening, so only
 * the first of those gets one.
 */
function displayState(
  state: PasswordRuleState,
  touched: boolean,
  breach: BreachStatus,
): ShownState {
  if (!touched) return "idle";
  if (state === "pending") return breach === "checking" ? "pending" : "idle";
  return state;
}

function RuleIcon({ state }: { state: ShownState }) {
  const className = "mt-0.5 h-4 w-4 shrink-0";
  if (state === "met") return <Check className={cn(className, "text-green-700")} aria-hidden />;
  if (state === "unmet") return <X className={cn(className, "text-destructive")} aria-hidden />;
  if (state === "pending")
    return <Loader2 className={cn(className, "animate-spin text-muted-foreground")} aria-hidden />;
  return <Circle className={cn(className, "text-muted-foreground/50")} aria-hidden />;
}
