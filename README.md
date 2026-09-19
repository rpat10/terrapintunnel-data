# terrapintunnel-data

Scheduled jobs that keep [TerrapinTunnel](https://github.com/rpat10/TerrapinTunnel)'s
course catalog current. They run on GitHub Actions and write to the site's
Supabase database with the service-role key.

| Job | When | What |
|---|---|---|
| `sync-daily.mjs` | Daily, 06:17 UTC (+ up to 20 min jitter), ~5 h | Testudo → `courses`, `sections` |
| `sync-planetterp-monthly.mjs` | 1st of the month, 14:00 UTC, ~30 min | PlanetTerp → `courses.avg_gpa`, `sections.prof_rating` / `prof_slug` |

The website no longer has live seat updates, watchlists, or seat-history graphs,
so the old every-30-minutes scrape, the watchlist job, and the daily
seat-snapshot job are gone. The `section_snapshots` table itself was dropped on
2026-09-19.

## The daily sync

For each term, in order:

1. `GET /soc/{term}`: the department list (~200 prefixes, read from the page,
   not hardcoded).
2. For each department, in shuffled order:
   - `GET /soc/{term}/{DEPT}`: course metadata. Upserts `courses`, and adds the
     term's label to `semesters_offered`, which the catalog's semester filter
     uses.
   - `GET /soc/{term}/sections?courseIds=…`: sections for 20–40 courses at a
     time. This is the same request Testudo's own "show sections" button
     makes. Upserts `sections`.

That comes to about 500 requests per term. The old job loaded ~9,000 course
pages in 20 minutes, every 30 minutes.

### Going slowly on purpose

- **Paced to fill the window.** Each gap is drawn around
  *time left ÷ requests left*, so the run spreads across `SYNC_TARGET_HOURS`
  (default 5) whatever the real request count is. That averages one request
  every ~18 s for two terms, never faster than one every 4 s.
- **Irregular timing.** The gaps are log-normally jittered, with an occasional
  multi-minute pause, like a person browsing. Departments are visited in random
  order.
- **One consistent browser.** The run keeps a single User-Agent and a cookie
  jar. Page loads send page-load headers; section loads send the XHR headers
  Testudo's own script sends.
- **Backs off when asked.** A 403, 429, or 503 honours `Retry-After`, or pauses
  5–15 minutes. After 4 consecutive failed requests the run stops rather than
  pushing on.
- **Stays inside GitHub's 6-hour limit.** No new requests after 5.6 h. The job
  timeout is 355 min. Each department is written as soon as it is scraped, so a
  run that stops early keeps what it did.

### It never deletes

A section Testudo stops listing (cancelled or renumbered) is **reported** at the
end of the term, not removed. Saved schedules reference section ids with no
foreign key, so a deleted section silently drops out of someone's schedule.
Clean stale sections up deliberately, after checking that none of them is saved
in a schedule.

## Terms

`scripts/terms.mjs` holds the term registry and `DAILY_TERM_IDS`, the terms
the cron refreshes, in order. Currently that is **Spring 2027** then
**Winter 2027**.

- Labels follow Testudo's term picker (`202612` is "Winter 2027"). They are
  written into `courses.semesters_offered` and must match the keys of
  `TERM_MAP` in TerrapinTunnel's `src/lib/terms.ts`.
- When Testudo publishes a new term, add it to `TERMS` and `DAILY_TERM_IDS`.
  Drop a term once students have moved on from it.
- For a one-off run of other terms, go to **Actions → Daily Sync → Run
  workflow**, enter `terms` (e.g. `202608,202701,202612`), and they are
  scraped in that order.

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in both values
npm test
npm run sync:daily:try        # dry run: CMSC only, short gaps, no DB writes
node scripts/sync-daily.mjs --dry-run --fast --terms=202612 --depts=ENGL,MATH
```

Flags: `--dry-run` (no writes; DB env vars optional), `--fast` (2–6 s gaps,
for testing only), `--terms=A,B` (in order), `--depts=A,B`.

## Setup

In the GitHub repo, under Settings → Secrets and variables → Actions, add:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Scheduled workflows only run from the default branch (`main`).
