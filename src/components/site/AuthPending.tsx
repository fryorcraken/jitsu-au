import { Loader2 } from "lucide-react";

/**
 * Shown while we work out whether the visitor is signed in.
 *
 * Establishing a session is never instant: the Supabase client has to finish
 * initialising, and on an email-link landing that also means exchanging the
 * tokens the link carries in the URL fragment for a session. Anything gated on
 * that has to render *something* in the meantime, or the visitor gets a blank
 * white page and assumes the link is broken.
 */
export function AuthPending({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}
