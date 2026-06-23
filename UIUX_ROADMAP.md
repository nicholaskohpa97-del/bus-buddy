# Bus Buddy — UI/UX Improvement Roadmap

A designer's review of Bus Buddy benchmarked against the best transit apps in the
world (Citymapper, Transit, Google Maps, Moovit), with a prioritized plan to
close the gaps and deliver a seamless, genuinely helpful experience.

---

## Where Bus Buddy stands today

**Strengths**
- Fast, lightweight PWA; clean teal design language; sensible 480px mobile layout.
- A genuinely good idea competitors don't focus on: **departure reminders +
  drop-off ("alight") alerts + one-tap Journey Modes.**
- Real-time arrivals, favourites, nearby search, and a clustered map.

**Honest gaps vs. the leaders**
| Area | Bus Buddy today | Best-in-class |
| --- | --- | --- |
| Background alerts | *(now fixed — server Web Push)* | Push that fires app-closed |
| Theme | Light only | Dark mode + auto |
| Arrivals card | Static "X min" | Ticking countdown, crowding, accessibility, last-bus |
| Map | Stops only | Route lines, stop sequences, live vehicles |
| Personalization | Manual favourites | Home/Work, commute-aware, cross-device sync |
| Accessibility | **No ARIA at all** | Full screen-reader + reduced-motion support |
| Language | English only | Multilingual (critical in SG: 中文 / Melayu / Tamil) |
| States | Bare "Loading…" text | Skeletons, retry, polished empty states |
| Onboarding | Cold API-key bar | Guided first run |

---

## Phase 0 — Foundations & polish *(highest ROI, low risk)*

1. **Dark mode.** Add a `[data-theme="dark"]` token set next to the existing
   `:root` CSS variables in `index.html` (lines ~15–33). Respect
   `prefers-color-scheme` and add a manual toggle in Settings. Table stakes for a
   transit app used at night.
2. **Real loading & error states.** Replace bare "Loading…" text
   (`app.js` dashboard/arrivals) with skeleton placeholders, and replace the
   inline red error string (`app.js` `loadArrivals`) with a friendly card + a
   **Retry** button.
3. **PWA install prompt** (Android `beforeinstallprompt`). Improves retention and
   is required for the most reliable Web Push behaviour.
4. **Respect `prefers-reduced-motion`** around the pulse/slide animations.

## Phase 1 — Information quality on the arrivals card *(the screen people live on)*

1. **Ticking countdown** (Transit-style) — recompute every second from
   `EstimatedArrival` instead of a frozen "X min".
2. **Richer per-bus info LTA already returns:** wheelchair accessibility (WAB),
   bus type, crowding/load with color coding, and **last-bus** highlighting so
   riders don't miss the final service.
3. **Pin / reorder services** within a stop so the user's usual bus is on top.
4. **Pull-to-refresh** and a clear "updated Ns ago / live" indicator.

## Phase 2 — Map & route intelligence *(biggest competitive gap)*

1. **Route lines + stop sequence.** The app already fetches `api/bus-routes.js`
   (currently unused) — use it to draw a service's path and list every stop it
   serves. This is a Citymapper/Google core feature.
2. **Arrival previews in map popups**, not just the stop name.
3. **Known limitation:** live vehicle GPS positions aren't freely available from
   LTA's public API — present an ETA-based view rather than promising live dots.

## Phase 3 — Personalization & smart alerts

1. **Home / Work shortcuts** built on the existing Journey Modes concept, with a
   one-tap "When should I leave?".
2. **Recurring, commute-aware reminders** by day-of-week, powered by the new
   server-push engine.
3. **Cross-device sync** of favourites and reminders (currently localStorage
   only) via the Supabase layer introduced with the alerts fix.

## Phase 4 — Inclusivity & reach

1. **Accessibility (largest correctness gap).** Add ARIA roles/labels to the
   icon-only buttons used throughout, `aria-live` for arrival updates,
   `<label for>` associations, modal focus management, and a contrast audit.
2. **Localization** — EN / 中文 / Bahasa Melayu / Tamil; extract UI strings to a
   dictionary. Significant for the Singapore market.
3. **Onboarding** — a 3-step first run (permissions → set Home/Work → enable
   alerts) replacing the cold API-key bar.

---

### Suggested sequencing
**Phase 0 + the background-alerts fix** deliver the most immediately felt
improvement and should ship first. Each later phase is independently shippable.
