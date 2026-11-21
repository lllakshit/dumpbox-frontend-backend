# DumpBox — web app and API

Dump anything in one tap. Find it in one search. On every device.

This repository holds the **web app** (Next.js, installable PWA) and the **API** (`/v1`, Next.js route handlers) used
by every client, including the Flutter app in `dumpbox-mobile-app`. Data lives in **Supabase** (Postgres, Auth,
Storage, Realtime). The site deploys to **Vercel**.

## What works today

| Area | Status |
|---|---|
| Sign-in | Email 6-digit code; Google (needs Google keys, see below) |
| Capture | Notes, links (with safe preview fetch), images, files (signed uploads, 50 MB cap, programs blocked), places (GPS) |
| Feed | Chat-style, newest at the bottom, date separators, infinite scroll, pin, star, archive, trash (30 days) + restore |
| Organize | Tags, collections (many per item), smart views (Notes, Links, Images, Documents, Places, Voice), bulk actions |
| Edits | Field-level merge across devices; last 10 versions of a note's text kept and restorable |
| Search | Full text with prefix matching and typo tolerance across text, link details, place names, tag and file names; filters by type, tag, collection, starred, dates; highlighted snippets |
| Sync | Realtime nudge + `/v1/changes` pull; offline capture queue (web) with exactly-once retry |
| Sharing | Private links for an item or a collection, expiry, download on/off, open counts, revoke |
| Account | Profile, usage, JSON export, delete account |

Not built yet (by agreement): AI features (OCR, semantic search, Q&A, tagging, summaries), end-to-end encrypted vaults,
WhatsApp / Telegram / email-in, reminders, billing, admin console, browser extension, desktop hotkey app.

## Local development

Needs Node 24, Docker and the Supabase CLI.

```bash
npm ci
supabase start -x studio,edge-runtime,logflare,vector,imgproxy,supavisor,postgres-meta
cp .env.example .env.local   # then paste PUBLISHABLE_KEY and SECRET_KEY from `supabase status -o env`
npm run dev
```

Open http://localhost:3000, enter any email, and read the code at http://127.0.0.1:54324 (local mail catcher).

| Command | What it checks |
|---|---|
| `npm run lint` / `npm run typecheck` | Code quality and types |
| `npm test` | Unit tests (link-preview safety, upload rules, cursors, schemas, OpenAPI covers every route) |
| `npm run test:db` | Database tests: row-level security between users, version history, tombstones, search |
| `npm run test:api` | End-to-end API tests against a running app (`npm run build && npm start` first) |

## Environment variables

| Name | Where | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (all envs) | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel (all envs) | Supabase publishable key (`sb_publishable_…`) |
| `NEXT_PUBLIC_APP_URL` | Vercel (all envs) | Public site URL, used in share links (e.g. `https://dumpbox.vercel.app`) |
| `SUPABASE_SECRET_KEY` | Vercel, **server only** | Supabase secret key (`sb_secret_…`). Never expose to the browser |
| `CRON_SECRET` | Vercel | Long random string; Vercel Cron sends it to `/v1/internal/purge` |

## Setting up Supabase (once)

1. Create a project in the **Mumbai (ap-south-1)** region.
2. Apply the schema: `supabase link --project-ref <ref>` then `supabase db push` (or let the *Database migrations*
   workflow do it, see CI/CD).
3. **Auth → Providers → Email:** enabled, *Confirm email* on.
4. **Auth → Email templates → Magic link** and **Confirm signup:** paste `supabase/templates/otp.html` (it shows the
   6-digit `{{ .Token }}`). Set the OTP expiry to 600 seconds.
5. **Auth → URL configuration:** Site URL = your Vercel URL; add `<site>/auth/callback` and
   `dumpbox://login-callback` (mobile) to redirect URLs.
6. **Google (optional):** create an OAuth client in Google Cloud, set the redirect URI to
   `https://<ref>.supabase.co/auth/v1/callback`, and paste the client id/secret under Auth → Providers → Google.
7. For real email delivery, add your SMTP provider under Auth → SMTP (the built-in sender is rate-limited).

## Deploying on Vercel

Import this repository, set the environment variables above, deploy. `vercel.json` adds security headers and a daily
cron (03:00 IST) that empties trash older than 30 days.

## CI/CD

- **CI** (`.github/workflows/ci.yml`, every PR and push to main): lint, typecheck, unit tests, build; then starts a
  local Supabase, runs the database tests, builds and starts the app, and runs the end-to-end API tests.
- **Database migrations** (`.github/workflows/migrate.yml`): after CI passes on main (or by hand), runs
  `supabase db push` against the hosted project. Add repository secrets `SUPABASE_ACCESS_TOKEN`,
  `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, and a `production` environment (add yourself as a required
  reviewer if you want to approve each run). Without the secrets the job is skipped.
- **Vercel** deploys previews for PRs and production from main through its Git integration.

## API

One versioned REST API at `/v1`, documented in OpenAPI at `/v1/openapi.json`. Authenticate with
`Authorization: Bearer <Supabase access token>`. Errors are `{ "error": { "code", "message", "details?" } }`.

- Capture is idempotent: send a client-generated `id` and retries never duplicate.
- Edits: send only changed fields, plus `base_version`. Different fields merge; the same text field keeps the latest
  and the previous text goes to version history.
- Sync: `GET /v1/changes` (full) or `?since=<token>`; repeat while `has_more`. `reset: true` means drop the cache.
- Files: `POST /v1/uploads` → `PUT` bytes to `upload_url` → `POST /v1/items/{id}/files`.

## Security notes

- Every table has row-level security; the API calls the database **as the user**, so a bug in a route still cannot
  reach another account's rows. The server key is used only for public share pages, account deletion and the purge job.
- Share tokens are 256-bit random and stored only as SHA-256 hashes.
- Link previews block private, loopback and metadata addresses at connect time (no DNS rebinding), cap size and time.
- Uploads go to a private bucket under `<user id>/…`; programs, scripts, HTML and SVG are refused.
