// The email switches, rendered by both places they appear: /notifications for
// somebody signed in, and /email-settings for somebody who clicked the link at
// the bottom of an email (that link is /email-settings/<token>, which sets a
// cookie and redirects here). One component so the two can never drift into
// offering different choices.
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { EmailPreferenceKey } from "@/lib/notifications";

type SwitchSpec = {
  key: EmailPreferenceKey;
  label: string;
  hint: string;
  /** Only shown to managers. A member has no use for it and would read it as
   * an offer of something they cannot have. */
  managerOnly?: boolean;
};

/** Written as what arrives in the inbox, not as what the system does. */
const SWITCHES: SwitchSpec[] = [
  {
    key: "reply_to_me",
    label: "Someone replies to me",
    hint: "Sent straight away, so you can answer while the conversation is live.",
  },
  {
    key: "thread_activity",
    label: "More activity on a thread I am in",
    hint: "Once a day, covering threads you have commented on.",
  },
  {
    key: "new_blog_post",
    label: "A new blog post goes up",
    hint: "Once a day. Off unless you turn it on.",
  },
  {
    key: "manager_comment_alerts",
    label: "New comments to review",
    hint: "Once a day, covering blog and knowledge base comments.",
    managerOnly: true,
  },
];

export function NotificationSwitches({
  values,
  onChange,
  disabled,
  isManager,
}: {
  values: Record<EmailPreferenceKey, boolean>;
  onChange: (key: EmailPreferenceKey, next: boolean) => void;
  disabled?: boolean;
  isManager?: boolean;
}) {
  const shown = SWITCHES.filter((s) => !s.managerOnly || isManager);
  return (
    <div className="space-y-4">
      {shown.map((spec) => (
        <div key={spec.key} className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor={`notify-${spec.key}`} className="text-sm font-medium">
              {spec.label}
            </Label>
            <p className="text-sm text-muted-foreground">{spec.hint}</p>
          </div>
          <Switch
            id={`notify-${spec.key}`}
            checked={values[spec.key]}
            disabled={disabled}
            onCheckedChange={(next) => onChange(spec.key, next)}
          />
        </div>
      ))}
      <p className="text-sm text-muted-foreground">
        These control email only. Everything still shows up on your notifications page, so turning
        one off never loses you the record of what happened.
      </p>
    </div>
  );
}
