# Bus Buddy — Setup

Bus Buddy requires a signed-in account. Authentication, per-user data and
background push all run on Supabase, with the reminder job on Vercel.

> **Upgrading from a pre-accounts deployment?** See
> [Migrating from device-id storage](#migrating-from-device-id-storage) at the
> bottom — the database schema changed and favourites are intentionally not
> carried over.

## 1. Generate VAPID keys

```bash
npx web-push generate-vapid-keys
```

This prints a `Public Key` and `Private Key`.

## 2. Environment variables

Vercel → Project → Settings → Environment Variables.

| Variable                    | Value                                                          |
| --------------------------- | -------------------------------------------------------------- |
| `LTA_API_KEY`               | LTA DataMall account key                                        |
| `SUPABASE_URL`              | your Supabase project URL                                       |
| `SUPABASE_ANON_KEY`         | Supabase anon/public key — safe to expose, RLS protects rows     |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key — **secret**, bypasses RLS             |
| `VAPID_PUBLIC_KEY`          | public key from step 1                                          |
| `VAPID_PRIVATE_KEY`         | private key from step 1                                         |
| `VAPID_SUBJECT`             | `mailto:you@example.com`                                        |
| `CRON_SECRET`               | a long random string (protects the check endpoint)              |
| `TELEGRAM_BOT_TOKEN`        | optional — only if you use the Telegram bot                     |

Redeploy after adding these.

**Why the service-role key is needed.** Every table below has row-level security
so one account can never read another's rows. The reminder cron has no user
session and must scan every account's reminders, so it — and only it — uses the
service-role key. Never return that key to a browser: `/api/config` deliberately
exposes just the URL and the anon key.

## 3. Supabase Auth

1. **Authentication → Providers → Email**: enable. Set the minimum password
   length to 8 to match the client-side rule (≥8 chars, ≥1 letter, ≥1 number).
2. **Authentication → Providers → Google**: enable and paste your Google OAuth
   client ID and secret from the
   [Google Cloud console](https://console.cloud.google.com/apis/credentials).
   Add Supabase's callback URL (`https://<project>.supabase.co/auth/v1/callback`)
   as an authorised redirect URI on the Google side.
3. **Authentication → URL Configuration**: set the Site URL to your deployed
   origin and add it to Redirect URLs, so the OAuth round-trip lands back in the
   app.

## 4. Database schema

Run in the Supabase SQL editor:

```sql
-- Per-account preferences: favourites, places, reminders, notify state.
create table if not exists user_prefs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- One row per device per account, so alerts reach every signed-in device.
create table if not exists push_subs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null,
  subscription jsonb,
  updated_at   timestamptz not null default now(),
  unique (user_id, device_id)
);

-- Journey modes, per account.
create table if not exists modes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  data       jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Telegram: chat → account binding, plus short-lived one-time link codes.
create table if not exists tg_links (
  chat_id    text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists tg_link_codes (
  code       text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);

-- Telegram conversation state (not user-scoped; keyed by chat).
create table if not exists tg_sessions (
  chat_id    text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Row-level security ────────────────────────────────────────────────────
alter table user_prefs    enable row level security;
alter table push_subs     enable row level security;
alter table modes         enable row level security;
alter table tg_links      enable row level security;
alter table tg_link_codes enable row level security;
alter table tg_sessions   enable row level security;

create policy "own prefs" on user_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own subs" on push_subs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own modes" on modes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own tg links" on tg_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own tg codes" on tg_link_codes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

`tg_sessions` gets no policy on purpose: only the bot touches it, and the bot
runs with the service-role key, which bypasses RLS.

`user_prefs.data` holds `{ reminders, favourites, places, notifyState }`.

## 5. Schedule the reminder check (Vercel Hobby)

Hobby cron only runs ~once a day, which is too slow for arrival alerts. Use a
free external pinger to call the endpoint every minute:

1. Sign up at **https://cron-job.org** (free).
2. Create a cron job:
   - **URL:** `https://<your-app>.vercel.app/api/check-reminders`
   - **Schedule:** every 1 minute
   - **Request method:** GET
   - **Header:** `Authorization: Bearer <your CRON_SECRET>`
3. Save and enable.

(UptimeRobot or any other pinger works too, as long as it sends the
`Authorization` header.)

> Upgrading to Vercel Pro later? Add a `crons` entry to `vercel.json`
> (`{ "path": "/api/check-reminders", "schedule": "* * * * *" }`) and drop the
> external pinger — the endpoint also accepts Vercel's own cron header.

## 6. Telegram bot (optional)

The bot manages journey modes for a **linked account**. An unlinked chat cannot
read or write anything.

1. In the app: **Settings → Connect Telegram → Generate link code**.
2. In Telegram: send `/link YOURCODE` to the bot within 10 minutes.

## 7. Verify

1. Open the app. You should land on the sign-in screen — the app is not usable
   signed out. Create an account (try a 5-character password first; it should be
   rejected) or use **Continue with Google**.
2. Allow notifications. Settings should show **"✅ Background alerts enabled"**.
3. Tap **Settings → Test background alert**, lock your phone — the notification
   should still arrive (it came from the server).
4. Create a departure reminder; it syncs to `user_prefs.data.reminders`.
5. Sign in on a second device with the same account — favourites and reminders
   should appear, and both devices should receive push.
6. Check config health without sending anything:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://<your-app>.vercel.app/api/check-reminders?probe=1"
   ```
   Every entry under `checks` should be `true`.

## Local development

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... LTA_API_KEY=... node local/server.js
```

Serves the app on `http://localhost:3456`. It implements `/api/config`,
`/api/bus-arrival`, `/api/bus-stops`, `/api/bus-routes` and `/api/geocode` only —
push, modes and the reminder cron are Vercel-only. Sign-in works locally as long
as the two Supabase variables are set and `http://localhost:3456` is in the
project's redirect URL list.

Run the reminder-cron tests with `npm test`.

## Migrating from device-id storage

Earlier versions keyed everything on a random `bb_deviceId` with no accounts, in
a `push_subs` table shaped `(device_id primary key, data jsonb)`. That schema is
replaced, not migrated:

- **Favourites, places and reminders are not carried over.** Users re-add them
  after signing in. This was deliberate: the old rows have no owner, so
  attributing them to an account would be guesswork.
- **Journey modes are not carried over either.** The old `modes` table stored
  every deployment's modes in a *single shared row* (`id = 1`), so those rows
  have no meaningful owner and were visible to all users.

Drop the old tables once you no longer need them, then create the new schema
from step 4:

```sql
drop table if exists push_subs;  -- old (device_id, data) shape
drop table if exists modes;      -- old single-row shape
```
