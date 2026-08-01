-- Bus Buddy — accounts migration
--
-- Run this once, in full, in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run) before deploying the
-- accounts branch. The app is unreachable until it has run, because sign-in
-- is now required and every table it reads is created here.
--
-- This is the same SQL as SETUP.md §4, extracted so it can be pasted in one go.
--
-- ⚠️  DESTRUCTIVE: the two DROPs below delete the old push_subs and modes
-- tables. That is deliberate, not collateral damage — both were keyed by a
-- random localStorage device id with no user column, so there is no correct
-- account to migrate their rows to. `modes` in particular was a single global
-- row (id = 1) shared by every visitor to the deployment.
--
-- If you want to keep a copy first:
--   create table push_subs_backup as select * from push_subs;
--   create table modes_backup    as select * from modes;

-- ── Clean up the pre-accounts schema ─────────────────────────────────────
drop table if exists push_subs;
drop table if exists modes;

-- ── Preferences: favourites, places, recent searches, settings ───────────
create table if not exists user_prefs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Push targets: one row per (account, device) ──────────────────────────
-- The unique constraint is what lets one account push to a phone and a laptop
-- at once; the old table could only ever hold one target per device id.
create table if not exists push_subs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null,
  subscription jsonb,
  updated_at   timestamptz not null default now(),
  unique (user_id, device_id)
);

-- ── Reminders: 'scheduled' (recurring) or 'oneshot' (one named bus) ──────
-- notify_state is written by the cron, payload by the client. Keeping them in
-- separate columns is what stops a user edit from resetting a fired
-- reminder's cooldown and re-firing it.
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
-- The cron follows the bus (LTA publishes NextBus.Latitude/Longitude) and
-- pushes when it reaches the stop before yours. A PWA can't watch the phone
-- in the background — navigator.geolocation doesn't exist in a service worker
-- and Chrome cancelled the Geofencing API — so the vehicle is the only thing
-- trackable with the app closed.
create table if not exists rides (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists rides_user_idx on rides (user_id);

-- ── Server-side key/value ────────────────────────────────────────────────
-- Holds the OneMap access token (3-day TTL) and the train-alert hash.
-- Serverless functions cold-start constantly, so an in-memory cache would be
-- empty most of the time; this row survives.
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
-- This is the part that makes the app multi-tenant-safe. Every user-facing
-- API route forwards the caller's own JWT, so Postgres — not application
-- code — decides which rows they can see.
alter table user_prefs    enable row level security;
alter table push_subs     enable row level security;
alter table reminders     enable row level security;
alter table modes         enable row level security;
alter table rides         enable row level security;
alter table kv            enable row level security;
alter table tg_links      enable row level security;
alter table tg_link_codes enable row level security;
alter table tg_sessions   enable row level security;

drop policy if exists "own prefs"     on user_prefs;
drop policy if exists "own subs"      on push_subs;
drop policy if exists "own reminders" on reminders;
drop policy if exists "own modes"     on modes;
drop policy if exists "own rides"     on rides;
drop policy if exists "own tg links"  on tg_links;

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

-- kv, tg_link_codes and tg_sessions get no policy at all. RLS with zero
-- policies denies everything to anon and authenticated, and only the service
-- key (which bypasses RLS) touches them. That's deliberate: a Telegram link
-- code has to be redeemable by the bot, which has no session.
