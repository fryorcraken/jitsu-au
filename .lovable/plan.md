# Scheduled digest: findings and recommendation

## What you asked

Replace the GitHub Actions scheduler that POSTs to `/api/notifications/digest` with something that lives in the running app or database, not in the repo.

## Factual answers to the four options

### 1. Lovable Cloud built-in scheduled jobs / cron

No. Lovable Cloud does not provide a first-party scheduler or cron UI. Previews and publishes are builds of the app; there is no separate "jobs" layer.

### 2. `pg_cron` + `pg_net` on the Supabase project

Not available on this project today.

- `pg_net` is available but not installed (`pg_available_extensions` shows `pg_net` 0.20.4).
- `pg_cron` is not in `pg_available_extensions` at all on this instance, so it cannot be installed via SQL. The instance is the "Tiny" size, which is why the extension is absent.

If `pg_cron` were available, this would be the natural choice: the database would call the TanStack API route on a schedule using `pg_net`, exactly like the project docs already describe for `pg_cron`. But without it, the database cannot be the scheduler.

### 3. Supabase Edge Functions with scheduled invocation

No. This project runs on TanStack Start, and the standing rule is to maintain existing Edge Functions only — new app logic goes in `createServerFn` or TanStack server routes. A scheduled Edge Function would also still need an external trigger (e.g., `pg_cron` or Cloudflare cron), which is the same scheduling problem you are trying to solve.

### 4. Cloudflare Cron Triggers

No. Lovable owns the Cloudflare deploy and there is no `wrangler.toml` in the repo. You do not have direct access to configure Cloudflare Cron Triggers or Workers settings.

## What that leaves

The existing endpoint is already the right endpoint: `POST /api/notifications/digest` with `Authorization: Bearer <NOTIFICATION_DIGEST_KEY>`. The only question is who triggers it.

Given the stack constraints, the practical choices are:

1. **Keep GitHub Actions** (current). It works, but it has the downsides you listed: the trigger lives in the repo, GitHub can delay scheduled workflows, and the credential sits in GitHub Secrets.
2. **Switch to a third-party cron service** (e.g., cron-job.org, EasyCron, or a similar HTTP scheduler). You configure the schedule, the URL, and the bearer token in the service, not in the repo. The app receives a plain HTTPS POST with the same auth it already accepts. This is the closest thing to a "running app" scheduler that does not require a platform feature Lovable or Supabase currently expose here.
3. **Wait / upgrade** to a Supabase plan that includes `pg_cron`, then migrate to a database-native cron. This would be the cleanest long-term solution, but it is not something you can turn on today.

## Recommendation

Use a third-party HTTP cron service for now. It is the only option that removes the credential from the repo, decouples the trigger from GitHub, and works with the existing endpoint unchanged.

If you want to keep the 7am Sydney target, the cron expression is still `0 20 * * *` UTC (which is 6am/7am Sydney depending on daylight saving).

## What I would need to set it up

- A chosen cron service and the URL it should POST to.
- The `NOTIFICATION_DIGEST_KEY` value to set as the `Authorization` header in that service.
- Optionally, rename the endpoint to `/api/public/notifications/digest` so it is clearly marked as a public-facing hook, but this is not required for it to work. The current route is already a public HTTP handler with its own bearer-token auth.

No code changes are strictly required unless you decide to move the route under `/api/public/` or switch to the `apikey: <anon-key>` convention that the project docs prefer for cron callers.

## Next step

Confirm which direction you want:

- A. Configure a third-party cron service (I can help pick one and write the setup steps).
- B. Move the endpoint to `/api/public/notifications/digest` and add `apikey`-based auth to align with the project's cron pattern.
- C. Leave the current GitHub Actions scheduler in place.
- D. Investigate upgrading the Supabase instance so `pg_cron` becomes available.
