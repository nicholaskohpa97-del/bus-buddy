-- ══════════════════════════════════════════════════════════════════
-- FastTrack — Supabase schema + Row Level Security
-- Run this once in your Supabase project's SQL editor.
-- Each table is scoped to the authenticated user via auth.uid().
-- The cron (api/check-reminders.js) reads push_subs with the SERVICE ROLE
-- key, which bypasses RLS.
-- ══════════════════════════════════════════════════════════════════

-- ── Profiles (goals / settings as a JSON blob) ──
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Fasts (active fast = ended_at is null) ──
create table if not exists public.fasts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  target_hours numeric not null,
  protocol text,
  updated_at timestamptz not null default now()
);
create index if not exists fasts_user_idx on public.fasts(user_id);

-- ── Food entries ──
create table if not exists public.food_entries (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  logged_on date not null,
  meal_type text not null,
  name text not null,
  brand text,
  qty numeric not null default 1,
  serving_label text,
  calories numeric not null default 0,
  protein_g numeric not null default 0,
  carbs_g numeric not null default 0,
  fat_g numeric not null default 0,
  source text default 'manual',
  updated_at timestamptz not null default now()
);
create index if not exists food_user_date_idx on public.food_entries(user_id, logged_on);

-- ── Custom (saved) foods ──
create table if not exists public.custom_foods (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  brand text,
  serving_label text,
  calories numeric not null default 0,
  protein_g numeric not null default 0,
  carbs_g numeric not null default 0,
  fat_g numeric not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists custom_user_idx on public.custom_foods(user_id);

-- ── Weight entries (one per day) ──
create table if not exists public.weight_entries (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  logged_on date not null,
  weight numeric not null,
  unit text not null default 'kg',
  updated_at timestamptz not null default now()
);
create index if not exists weight_user_idx on public.weight_entries(user_id, logged_on);

-- ── Push subscriptions + reminder snapshot (read by cron via service role) ──
create table if not exists public.push_subs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ══════════════════════════ RLS ══════════════════════════
alter table public.profiles       enable row level security;
alter table public.fasts          enable row level security;
alter table public.food_entries   enable row level security;
alter table public.custom_foods   enable row level security;
alter table public.weight_entries enable row level security;
alter table public.push_subs      enable row level security;

-- Helper: one "own rows" policy per table, covering all operations.
do $$
declare t text;
begin
  foreach t in array array['profiles','fasts','food_entries','custom_foods','weight_entries','push_subs']
  loop
    execute format('drop policy if exists own_rows on public.%I;', t);
    execute format(
      'create policy own_rows on public.%I for all
         using (auth.uid() = user_id)
         with check (auth.uid() = user_id);', t);
  end loop;
end $$;
