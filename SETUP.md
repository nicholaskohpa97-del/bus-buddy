# Bus Buddy — Setup

Bus Buddy needs a Supabase project (accounts + server state), an LTA DataMall
key (bus data), and VAPID keys (Web Push). Everything below is one-time setup.

## 1. Accounts (Supabase Auth)

Sign-in is **required** — there is no guest mode. Identity used to be a random
`bb_deviceId` in localStorage, which made cross-device sync impossible and left
journey modes in a single row shared by every visitor to the deployment.

In your Supabase project:

1. **Authentication → Providers → Email** — enable it. Set **Minimum password
   length** to `8`, to match the rule the client enforces. (The client also
   requires at least one letter and one number; Supabase can't express that, so
   the client check is the only place it's enforced — that's fine, it's a
   usability rule, not a security boundary.)
2. **Authentication → Providers → Google** — enable it and paste in a Google
   OAuth client ID/secret from the
   [Google Cloud console](https://console.cloud.google.com/apis/credentials).
   Add `https://<your-project>.supabase.co/auth/v1/callback` as an authorised
   redirect URI on the Google side.
3. **Authentication → URL Configuration** — set **Site URL** to your deployed
   origin (e.g. `https://bus-buddy.vercel.app`) and add it under **Redirect
   URLs**. Google sign-in and password resets both land back here.

## 2. Generate VAPID keys

```bash
npx web-push generate-vapid-keys
```

This prints a `Public Key` and `Private Key`.

## 3. Environment variables

Vercel → Project → Settings → Environment Variables.

| Variable                    | Value                                                          |
| --------------------------- | -------------------------------------------------------------- |
| `SUPABASE_URL`              | `https://<project>.supabase.co`                                  |
| `SUPABASE_ANON_KEY`         | project **anon / publishable** key — served to the browser       |
| `SUPABASE_SERVICE_ROLE_KEY` | project **service role / secret** key — server-only, never sent to the browser |
| `LTA_API_KEY`               | from datamall.lta.gov.sg → Request for API Access                |
| `VAPID_PUBLIC_KEY`          | public key from step 2                                           |
| `VAPID_PRIVATE_KEY`         | private key from step 2                                          |
| `VAPID_SUBJECT`             | `mailto:you@example.com`                                         |
| `CRON_SECRET`               | a long random string (protects the check endpoint)               |
| `ONEMAP_EMAIL`              | OneMap account email — journey planning and fares                 |
| `ONEMAP_PASSWORD`           | OneMap account password                                          |
| `TELEGRAM_BOT_TOKEN`        | optional — only if you use the Telegram bot                      |
| `TELEGRAM_WEBHOOK_SECRET`   | optional but strongly recommended alongside the bot (see §6)     |

`ONEMAP_EMAIL` / `ONEMAP_PASSWORD` come from a free account at
[onemap.gov.sg](https://www.onemap.gov.sg/apidocs/register). They're needed for
the journey planner: OneMap's geocoder is public, but its routing service is
not. Google Directions was the alternative and can't do this job — it returns
no Singapore fare data at all, and its terms require results to be shown on a
Google map, which conflicts with this app's Leaflet/OpenStreetMap stack.

`SUPABASE_SERVICE_ROLE_KEY` is new and **required**. Once row-level security is
on, the anon key can only ever see the calling user's own rows — which is the
point — but the reminder cron has no user, and has to read across every
account. That one path uses the service key; everything user-facing goes
through the caller's own JWT so RLS does the scoping.

Redeploy after adding these.

## 4. Database schema

Run this in the Supabase SQL editor. It replaces the old `push_subs` and
`modes` tables.

```sql
-- ── Clean up the pre-accounts schema ─────────────────────────────────────
-- The old push_subs was keyed by a device id with no user column, and modes
-- was a single global row (id = 1) shared by everyone. Neither can be
-- migrated to a user_id that was never recorded.
drop table if exists push_subs;
drop table if exists modes;

-- ── Preferences: favourites, places, recent searches, settings ───────────
create table if not exists user_prefs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Push targets: one row per (account, device) ──────────────────────────
create table if not exists push_subs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null,
  subscription jsonb,
  updated_at   timestamptz not null default now(),
  unique (user_id, device_id)
);

-- ── Reminders: 'scheduled' (recurring) or 'oneshot' (one named bus) ──────
create table if not exists reminders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  type         text not null default 'scheduled',
  payload      jsonb not null default '{}'::jsonb,
  notify_state jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);
create index if not exists reminders_user_idx on reminders (user_id);

-- ── Journey modes ────────────────────────────────────────────────────────
create table if not exists modes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists modes_user_idx on modes (user_id);

-- ── Active rides: the server-tracked half of a drop-off alert ────────────
-- The cron follows the *bus* (LTA publishes NextBus.Latitude/Longitude) and
-- pushes when it reaches the stop before yours. A PWA can't watch the phone
-- in the background — navigator.geolocation doesn't exist in a service
-- worker and Chrome cancelled the Geofencing API — so the vehicle is the
-- only thing that can be tracked with the app closed.
create table if not exists rides (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists rides_user_idx on rides (user_id);

-- ── Server-side key/value (OneMap access token) ──────────────────────────
-- The token lasts three days. Serverless functions cold-start constantly, so
-- an in-memory cache would be empty most of the time; this row survives.
create table if not exists kv (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Telegram pairing ─────────────────────────────────────────────────────
-- A webhook carries a chat id and nothing else, so the bot can't know which
-- account is typing. The app mints a short-lived code the user sends to the
-- bot once; the bot trades it for a user_id and remembers the pairing.
create table if not exists tg_links (
  chat_id   bigint primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now()
);
create table if not exists tg_link_codes (
  code       text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists tg_sessions (
  chat_id    bigint primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Row-level security ───────────────────────────────────────────────────
alter table user_prefs    enable row level security;
alter table push_subs     enable row level security;
alter table reminders     enable row level security;
alter table modes         enable row level security;
alter table rides         enable row level security;
alter table kv            enable row level security;
alter table tg_links      enable row level security;
alter table tg_link_codes enable row level security;
alter table tg_sessions   enable row level security;

create policy "own prefs"     on user_prefs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own subs"      on push_subs  for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own reminders" on reminders  for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own modes"     on modes      for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rides"     on rides      for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own tg links"  on tg_links   for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- kv, tg_link_codes and tg_sessions get no policy at all: RLS with zero policies
-- denies everything to anon/authenticated, and only the service key (which
-- bypasses RLS) touches them. That's deliberate — a link code must be
-- redeemable by the bot, which has no session.
```

### A note on existing favourites

Favourites are **not** migrated. The old rows are keyed by a device id with no
account attached, so there is no correct user to assign them to, and the shape
changed (a favourite is now a stop *or* a specific service at a stop). The app
clears the old local list once, with a toast, and starts fresh.

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

## 6. Rail network data

`data/mrt.json` is committed to the repo — the map overlay, station search and
the "near MRT" badge on bus stops all read it. LTA's own station dataset ships
as an ESRI shapefile inside a zip, which is impractical to parse at runtime,
and the rail network changes only a few times a year, so static is the right
call.

Regenerate it when a line or station opens:

```bash
node scripts/build-mrt-data.js
```

The script pulls heavy rail (NS/EW/NE/CC/DT/TE) and the LRT lines from two
open datasets, merges them, derives interchanges, and fails loudly if a line
segment references a station it doesn't have — a silent hole would draw a
polyline across the map.

Rail **disruption** alerts come from LTA DataMall's `TrainServiceAlerts`, which
is polled on the same minute tick as the reminders. There is no bus equivalent:
LTA publishes no bus-disruption API, and the operators announce them on social
media only. Bus alerts are deliberately out of scope, and the settings UI says
so rather than implying they're covered.

## 7. Telegram bot (optional)

Register the webhook with a secret token, so a leaked URL isn't enough to
impersonate a linked chat:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<your-app>.vercel.app/api/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Then in the app: **Settings → Telegram → Get link code**, and send
`/link <CODE>` to the bot within 10 minutes.

## 8. Verify

1. **Accounts** — sign up with email/password (a 6-character password should be
   rejected client-side), then sign in with Google. Confirm the app is
   unreachable while signed out. In Supabase, check that new rows carry a
   `user_id`, and that a second account can't see the first's rows.
2. **Push** — open the app on your phone, allow notifications. Settings should
   show **"✅ Background alerts enabled"**. Sign in on a second device and
   confirm **Settings → Test background alert** reaches both.
3. **Reminders** — create a departure reminder; confirm a row appears in
   `reminders`. When the bus is within your lead time during the reminder
   window, you get a push even with the app closed.
4. **Favourites and history** — star a specific service at a stop and confirm
   the list orders by real distance (and falls back gracefully with location
   denied). Search a few times and confirm the history appears when a search
   box is focused and empty, and that ✕ / Clear all work.
5. **One-shot reminders** — tap an arrival time in the Search tab and confirm
   the bus. Pushes should land roughly 3 minutes apart, the reminder should
   delete itself when the bus arrives, and the notification's **Dismiss**
   button should stop it early. `POST /api/dismiss-reminder` is authorised by
   a per-reminder token carried in the push payload, not a session — the
   service worker has no access token.
6. **Journey planning** — plan a real trip and check the duration and fare.
   The fare is an **adult card fare**; concession and cash fares differ and
   OneMap returns one figure, so the UI labels it rather than implying it
   applies to everyone. `GET /api/onemap-token` reports whether a token can be
   obtained (it never returns the token itself).
7. **Drop-off, the critical test** — open a bus route, tap 📍 **Set as my
   stop** on a stop a few ahead of you, then *fully close the app and lock the
   phone*. The "your stop is next" push should still arrive one stop early.
   This is the whole point of tracking the bus rather than the handset, so if
   it only works with the app open, something is wrong.
8. **Rail** — turn on the 🚆 overlay on the Map tab and check the lines and
   interchanges look right. Query Sengkang → Jurong East in the train planner
   and check the fare against TransitLink's published fare calculator.
9. **Disruption alerts** — real disruptions can't be summoned on demand, so
   POST a mocked payload to exercise the diff-and-push path:

   ```bash
   curl -X POST https://<your-app>.vercel.app/api/train-alerts \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"value":{"Status":2,"AffectedSegments":[{"Line":"EWL","Direction":"Boon Lay","Stations":"EW21,EW22,EW23"}]}}'
   ```

   A second identical POST should report `changed: false` and send nothing —
   that's the hash diff doing its job. POST `{"value":{"Status":1,
   "AffectedSegments":[]}}` to get the recovery notice.
10. **Config health** — `GET /api/check-reminders?probe=1` with
   `Authorization: Bearer $CRON_SECRET` reports env-var and DB health without
   sending anything.

## Local development

```bash
node local/server.js   # http://localhost:3456
```

`local/server.js` implements `check-key`, `bus-arrival`, `bus-stops`,
`bus-routes`, `geocode` and `route-plan` (the last needs `ONEMAP_EMAIL` /
`ONEMAP_PASSWORD` in the environment). Anything account-backed (`config`,
`prefs`, `reminders`, `push`, `modes`, `rides`) needs a real Supabase project,
so sign-in, sync and background pushes are not exercisable offline — run those
against a preview deployment.
