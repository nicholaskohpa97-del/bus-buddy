# ⏳ FastTrack — Fasting & Nutrition Tracker

A mobile-first **PWA** for intermittent fasting, food/macro/calorie logging, and weight
tracking. Vanilla JS (native ES modules, no build step), deployed as static files +
Vercel serverless functions, with optional Supabase cloud sync and Web-Push reminders.

## Features

- **Fast** — start/stop fasting windows with a live progress ring and countdown, protocol
  presets (14:10, 16:8, 18:6, 20:4, OMAD, 36h) or a custom length, editable start time,
  plus fasting history and a day streak.
- **Diary** — log food per meal. Search a real food database (**Open Food Facts** — no API
  key) by name, add saved/custom foods, or enter macros manually. See daily calories and
  protein/carbs/fat against your goals, per day.
- **Weight** — log body weight, view a trend chart (7d/30d/all), and track change vs a goal.
- **Reminders** — optional push notifications for *fast complete* and a *daily weigh-in*.
- **Cloud sync** — optional email sign-in (Supabase) syncs everything across devices.
  Works fully offline on one device with no account.

## Run locally

```bash
npm install
npm run dev          # → http://localhost:3456
```

Locally, `/api/config` returns no keys, so the app runs in **local-only mode**
(localStorage) — food search still works through the Open Food Facts proxy. To exercise
cloud sync and push, deploy with the env vars below (see `SETUP.md`).

## Architecture

| Layer | What |
|---|---|
| UI | `index.html` (app shell + design system), feature modules `fasting.js` / `diary.js` / `weight.js` / `settings.js`, `charts.js` (inline SVG) |
| Core | `main.js` (router/boot), `state.js` (local + cloud sync), `supabase.js`, `ui.js`, `pushclient.js` |
| API | `api/food-search.js` (Open Food Facts proxy), `api/config.js`, `api/check-reminders.js` (cron) |
| Data | Supabase Postgres + RLS (`supabase/schema.sql`) |
| PWA | `manifest.json`, `sw.js` (offline cache + push) |

See **`SETUP.md`** for deployment and environment configuration.
