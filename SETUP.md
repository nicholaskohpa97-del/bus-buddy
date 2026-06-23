# Bus Buddy — Background Alerts Setup

Departure reminders fire even when the app is closed via **Web Push**. A server
job checks LTA arrivals and pushes to the device. This requires a one-time setup.

## 1. Generate VAPID keys

```bash
npx web-push generate-vapid-keys
```

This prints a `Public Key` and `Private Key`.

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable             | Value                                                        |
| -------------------- | ----------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`   | public key from step 1                                       |
| `VAPID_PRIVATE_KEY`  | private key from step 1                                      |
| `VAPID_SUBJECT`      | `mailto:you@example.com`                                     |
| `CRON_SECRET`        | a long random string (protects the check endpoint)          |
| `SUPABASE_URL`       | already set (used by journey modes)                         |
| `SUPABASE_ANON_KEY`  | already set                                                 |
| `LTA_API_KEY`        | already set                                                 |

Redeploy after adding these.

## 3. Supabase table

Run in the Supabase SQL editor:

```sql
create table if not exists push_subs (
  device_id  text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
```

`data` holds `{ subscription, reminders, notifyState }` per device.

## 4. Schedule the reminder check (Vercel Hobby)

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

## 5. Verify

1. Open the app on your phone, allow notifications. Settings should show
   **"✅ Background alerts enabled"**.
2. Tap **Settings → Test background alert**, lock your phone — the notification
   should still arrive (it came from the server).
3. Create a departure reminder; it syncs to `push_subs.data.reminders`.
4. When the bus is within your lead time during the reminder window, you get a
   push even with the app closed.
