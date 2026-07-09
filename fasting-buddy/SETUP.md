# FastTrack — Setup & Deployment

The app works with **zero configuration** in local-only mode. Cloud sync and push
notifications are optional and enabled by setting environment variables.

## 1. Supabase (cloud sync + reminders)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run the contents of [`supabase/schema.sql`](supabase/schema.sql).
   This creates the tables and Row Level Security policies.
3. In **Authentication → Providers → Email**, keep **Email** enabled. The app uses the
   email OTP (6-digit code) flow — no password needed. (You can disable "Confirm email"
   for a smoother first sign-in, or leave it on.)
4. From **Project Settings → API**, note:
   - `Project URL` → `SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` (server-only; used by the cron)

## 2. VAPID keys (Web Push)

```bash
npx web-push generate-vapid-keys
```

Use the output for `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.

## 3. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Where used | Notes |
|---|---|---|
| `SUPABASE_URL` | config + cron | Project URL |
| `SUPABASE_ANON_KEY` | `/api/config` (client) | Public anon key — safe to expose; RLS protects data |
| `SUPABASE_SERVICE_ROLE_KEY` | cron only | **Secret.** Lets the cron read all `push_subs` |
| `VAPID_PUBLIC_KEY` | config + cron | Web Push |
| `VAPID_PRIVATE_KEY` | cron only | **Secret** |
| `VAPID_SUBJECT` | cron | e.g. `mailto:you@example.com` |
| `CRON_SECRET` | cron auth | Any random string; lets you trigger the cron manually |

## 4. Deploy to Vercel

```bash
vercel        # or connect the repo in the Vercel dashboard
```

`vercel.json` registers the reminder cron (`/api/check-reminders`, every minute).
On Vercel's Hobby plan crons run at most daily — for minute-level reminders either use a
paid plan or an external pinger (e.g. cron-job.org) hitting
`https://YOUR_APP/api/check-reminders` with header `Authorization: Bearer <CRON_SECRET>`.

## 5. Verify

- **Config**: open `https://YOUR_APP/api/config` → should return your Supabase URL, anon
  key, and VAPID public key (nulls mean an env var is missing).
- **Food search**: `https://YOUR_APP/api/food-search?q=banana` → JSON `results`.
- **Cron wiring**: `curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://YOUR_APP/api/check-reminders?probe=1"` → `{ ok: true, ... }` when all env vars
  and the DB are reachable.
- **Sync**: sign in via **Settings → Sync across devices** on two devices; data logged on
  one appears on the other after it loads.
- **Push**: enable **Settings → Reminders → Push notifications**, start a short fast, and
  confirm the *fast complete* notification fires after the goal time.

## Notes

- One device, no account: everything is stored in `localStorage` and works offline.
- When you first sign in, local data is pushed to the cloud, then the cloud set is pulled —
  so nothing logged before signing in is lost.
- Offline edits sync opportunistically on the next successful write; deletes made while
  offline are not yet reconciled to the cloud (a known limitation).
