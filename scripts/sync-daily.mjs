// ─────────────────────────────────────────────────────────────────────────────
// sync-daily.mjs — the one daily Testudo scrape.
//
// Refreshes courses + sections for the terms in terms.mjs, in order, and
// deliberately takes most of a day's off-peak window to do it (~5 hours by
// default) so the load on Testudo is a trickle rather than a burst.
//
// Per term:
//   1. GET /soc/{termId}                 → the department list (≈200)
//   2. For each department, in shuffled order:
//        GET /soc/{termId}/{DEPT}        → course metadata
//        upsert `courses` (semesters_offered gains this term's label)
//        GET /soc/{termId}/sections?courseIds=…   (a few per department —
//             the same request Testudo's "show all sections" button makes)
//        upsert `sections`
//
// That is roughly 500 requests per term — one every ~18 seconds on average
// for two terms over five hours — versus the ~9,000 per-course page loads the old
// every-30-minutes job made in 20 minutes.
//
// Never deletes. A section Testudo stops listing (cancelled) is reported, not
// removed: deleting a section cascades into section_snapshots, which cannot
// be re-scraped, and saved schedules still reference section ids.
//
// Usage:
//   node scripts/sync-daily.mjs                       daily terms (the cron job)
//   node scripts/sync-daily.mjs --terms=202608,202701,202612   explicit terms, in order
//   node scripts/sync-daily.mjs --dry-run --fast --depts=CMSC --terms=202701
//
// Flags:
//   --dry-run          parse and log, write nothing (DB env vars optional)
//   --fast             short gaps (2–6 s) for local testing — never on cron
//   --terms=A,B        these term ids, in this order, instead of DAILY_TERM_IDS
//   --depts=A,B        only these department prefixes
// Env:
//   SYNC_TARGET_HOURS      spread requests over this long (default 5)
//   SYNC_HARD_STOP_HOURS   stop making requests after this long (default 5.6;
//                          GitHub kills a job at 6 h)
//   SYNC_START_JITTER_MIN  random delay before the first request (default 0)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { DAILY_TERM_IDS, TERMS, resolveTerms } from './terms.mjs'
import { BASE, TestudoClient } from './lib/http.mjs'
import { Pacer, sleep } from './lib/pacer.mjs'
import { mergeSemesters, parseDepartmentCourses, parseDepartments, parseSections } from './lib/parse.mjs'

dotenv.config({ path: '.env.local' })

// ── Options ─────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
const DRY_RUN = Boolean(args['dry-run'])
const FAST = Boolean(args.fast)
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null)
const ONLY_DEPTS = list(args.depts) && new Set(list(args.depts))

const HOUR = 3_600_000
const TARGET_MS = FAST ? 0 : Number(process.env.SYNC_TARGET_HOURS ?? 5) * HOUR
const HARD_STOP_MS = Number(process.env.SYNC_HARD_STOP_HOURS ?? 5.6) * HOUR
const START_JITTER_MS = FAST ? 0 : Number(process.env.SYNC_START_JITTER_MIN ?? 0) * 60_000

const MAX_CONSECUTIVE_FAILURES = 4   // then stop: Testudo is unhappy or down
const EST_DEPTS_PER_TERM = 205       // until a term's root page says otherwise
const MAX_REQUESTS_PER_DEPT = 20     // runaway guard (≈600 courses)

let terms
try {
  terms = resolveTerms(list(args.terms) ?? DAILY_TERM_IDS)
} catch (err) {
  console.error(`${err.message}. Known: ${Object.keys(TERMS).join(', ')}`)
  process.exit(1)
}

// ── Database ────────────────────────────────────────────────────────────────
const hasDb = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
if (!DRY_RUN && !hasDb) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry-run).')
  process.exit(1)
}
const supabase = hasDb
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null

async function selectAll(build) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw error
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

// Professor ratings come from the monthly PlanetTerp job. New sections would
// otherwise show no rating for up to a month, so reuse what that job already
// wrote for the same instructor elsewhere.
async function loadRatings() {
  const exact = new Map()   // full instructor string → { rating, slug }
  const byName = new Map()  // single instructor name → { rating, slug }
  if (!supabase) return { exact, byName }
  const rows = await selectAll(() =>
    supabase.from('sections').select('instructor, prof_rating, prof_slug').not('prof_rating', 'is', null).order('id')
  )
  for (const r of rows) {
    const v = { rating: Number(r.prof_rating), slug: r.prof_slug ?? null }
    exact.set(r.instructor, v)
    if (!r.instructor.includes(' / ')) byName.set(r.instructor, v)
  }
  return { exact, byName }
}

function ratingFor(instructor, { exact, byName }) {
  if (!instructor || instructor === 'TBA') return { prof_rating: null, prof_slug: null }
  const hit = exact.get(instructor)
  if (hit) return { prof_rating: hit.rating, prof_slug: hit.slug }
  const names = instructor.split(' / ').map((n) => n.trim())
  const found = names.map((n) => byName.get(n)).filter(Boolean)
  if (found.length === 0) return { prof_rating: null, prof_slug: null }
  const avg = found.reduce((a, b) => a + b.rating, 0) / found.length
  return {
    prof_rating: Number(avg.toFixed(2)),
    prof_slug: names.length === 1 ? found[0].slug : null,
  }
}

async function upsertCourses(courses, label, now) {
  if (!supabase) return
  const ids = courses.map((c) => c.id)
  const { data, error } = await supabase.from('courses').select('id, semesters_offered').in('id', ids)
  if (error) throw error
  const existing = new Map(data.map((r) => [r.id, r.semesters_offered]))
  const rows = courses.map((c) => ({
    ...c,
    semesters_offered: mergeSemesters(existing.get(c.id), label),
    updated_at: now,
  }))
  if (DRY_RUN) return
  const { error: upErr } = await supabase.from('courses').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
}

async function upsertSections(sections) {
  if (!supabase || DRY_RUN || sections.length === 0) return
  for (let i = 0; i < sections.length; i += 500) {
    const { error } = await supabase.from('sections').upsert(sections.slice(i, i + 500), { onConflict: 'id' })
    if (error) throw error
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Split course ids into requests of 20–40, a size Testudo's own UI would ask for.
function chunkIds(ids) {
  const chunks = []
  for (let i = 0; i < ids.length; ) {
    const n = 20 + Math.floor(Math.random() * 21)
    chunks.push(ids.slice(i, i + n))
    i += n
  }
  return chunks
}

const fmt = (ms) => `${Math.floor(ms / HOUR)}h${String(Math.floor((ms % HOUR) / 60_000)).padStart(2, '0')}m`

class Abort extends Error {}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now()
  const runStamp = new Date(startedAt).toISOString()
  console.log('==================================================')
  console.log('🐢 DAILY SYNC — slow Testudo refresh')
  console.log(`   ${runStamp}${DRY_RUN ? '  (dry run — no writes)' : ''}${FAST ? '  (fast mode)' : ''}`)
  console.log(`   Terms, in order: ${terms.map((t) => `${t.label} (${t.termId})`).join(' → ')}`)
  console.log(`   Target duration ${fmt(TARGET_MS)}, hard stop ${fmt(HARD_STOP_MS)}`)
  console.log('==================================================\n')

  if (START_JITTER_MS > 0) {
    const jitter = Math.floor(Math.random() * START_JITTER_MS)
    console.log(`⏳ Start jitter: waiting ${Math.round(jitter / 60_000)} min\n`)
    await sleep(jitter)
  }

  const ratings = await loadRatings()
  console.log(`⭐ ${ratings.exact.size} rated instructor strings loaded for new sections\n`)

  const client = new TestudoClient()
  const pacer = FAST
    ? new Pacer({ targetMs: 0, minGapMs: 2_000, maxGapMs: 6_000, breakChance: 0 })
    : new Pacer({ targetMs: TARGET_MS - (Date.now() - startedAt), minGapMs: 4_000, maxGapMs: 3 * 60_000 })
  const hardStopAt = startedAt + HARD_STOP_MS

  // Remaining-request estimate that drives the pacer.
  let reqPerDeptAvg = 2.5
  let deptsDone = 0
  const deptCounts = terms.map(() => (ONLY_DEPTS ? ONLY_DEPTS.size : EST_DEPTS_PER_TERM))
  const remainingEstimate = (inDeptLeft = 0) => {
    const deptsLeft = deptCounts.reduce((a, b) => a + b, 0) - deptsDone
    const rootsLeft = terms.length - termsStarted
    return Math.max(1, Math.round(rootsLeft + deptsLeft * reqPerDeptAvg + inDeptLeft))
  }
  let termsStarted = 0
  let firstRequest = true
  let consecutiveFailures = 0

  const request = async (path, kind, referer, inDeptLeft) => {
    if (Date.now() > hardStopAt) throw new Abort(`hard stop reached after ${fmt(Date.now() - startedAt)}`)
    if (!firstRequest) await pacer.wait(remainingEstimate(inDeptLeft))
    firstRequest = false
    try {
      const html = await client.get(path, kind, referer)
      consecutiveFailures = 0
      return html
    } catch (err) {
      consecutiveFailures++
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Abort(`${consecutiveFailures} consecutive failed requests (last: ${err.message}) — stopping so we don't keep hitting Testudo`)
      }
      throw err
    }
  }

  const stats = { courses: 0, sections: 0, failedDepts: [], failedChunks: 0, missingCourses: 0, dbErrors: 0 }
  let abortReason = null

  try {
    for (let t = 0; t < terms.length; t++) {
      const { label, termId } = terms[t]
      termsStarted = t + 1
      const rootUrl = `${BASE}/soc/${termId}`
      console.log(`🌐 ${label} (${termId})`)

      const rootHtml = await request(`/soc/${termId}`, 'page')
      let depts = parseDepartments(rootHtml)
      if (ONLY_DEPTS) depts = depts.filter((d) => ONLY_DEPTS.has(d))
      if (depts.length === 0) throw new Abort(`no departments parsed for ${termId} — page structure may have changed`)
      deptCounts[t] = depts.length
      shuffle(depts)
      console.log(`   ${depts.length} departments\n`)

      const seen = new Set()
      let termComplete = true
      let termCourses = 0
      let termSections = 0

      for (let d = 0; d < depts.length; d++) {
        const dept = depts[d]
        const deptPath = `/soc/${termId}/${dept}`
        let deptRequests = 0
        try {
          const deptHtml = await request(deptPath, 'page', rootUrl, 0)
          deptRequests++
          const courses = parseDepartmentCourses(deptHtml).filter((c) => !seen.has(c.id))
          courses.forEach((c) => seen.add(c.id))

          if (courses.length > 0) {
            const now = new Date().toISOString()
            try {
              await upsertCourses(courses, label, now)
            } catch (err) {
              stats.dbErrors++
              console.error(`   ❌ ${dept}: course upsert failed — ${err.message}`)
              throw err  // sections would violate the course FK
            }
            termCourses += courses.length

            const chunks = chunkIds(courses.map((c) => c.id))
            let deptSections = 0
            for (let c = 0; c < chunks.length && deptRequests < MAX_REQUESTS_PER_DEPT; c++) {
              try {
                const html = await request(
                  `/soc/${termId}/sections?courseIds=${chunks[c].join(',')}`, 'xhr', BASE + deptPath, chunks.length - c - 1
                )
                deptRequests++
                const byCourse = parseSections(html, termId)
                const missing = chunks[c].filter((id) => !byCourse.has(id))
                if (missing.length) {
                  // Normal for a few listings with nothing scheduled (thesis
                  // research, e.g. ENGL699). Every course missing at once
                  // would mean the markup changed — watch the summary count.
                  stats.missingCourses += missing.length
                  console.log(`   ·  ${dept}: no sections listed for ${missing.join(', ')}`)
                }
                const rows = [...byCourse.values()].flat().map((s) => ({
                  ...s,
                  ...ratingFor(s.instructor, ratings),
                  updated_at: new Date().toISOString(),
                }))
                await upsertSections(rows)
                deptSections += rows.length
              } catch (err) {
                if (err instanceof Abort) throw err
                stats.failedChunks++
                termComplete = false
                console.error(`   ❌ ${dept} sections chunk ${c + 1}/${chunks.length}: ${err.message}`)
              }
            }
            termSections += deptSections
          }
        } catch (err) {
          if (err instanceof Abort) throw err
          termComplete = false
          stats.failedDepts.push(`${termId}/${dept}`)
          console.error(`   ❌ ${dept}: ${err.message}`)
        }

        deptsDone++
        reqPerDeptAvg += (Math.max(1, deptRequests) - reqPerDeptAvg) / Math.min(deptsDone, 30)
        const elapsed = Date.now() - startedAt
        console.log(`   [${d + 1}/${depts.length}] ${dept.padEnd(4)}  ${termCourses} courses, ${termSections} sections so far  (${fmt(elapsed)} elapsed, ${client.requests} requests)`)
      }

      if (termCourses > 0 && termSections === 0) {
        throw new Abort(`${label}: ${termCourses} courses but zero sections parsed — Testudo's markup has probably changed`)
      }
      stats.courses += termCourses
      stats.sections += termSections
      console.log(`\n✅ ${label}: ${termCourses} courses, ${termSections} sections\n`)

      // Report sections Testudo no longer lists. Only meaningful after a
      // complete, unfiltered pass over the term.
      if (supabase && termComplete && !ONLY_DEPTS && !DRY_RUN) {
        const { data, count, error } = await supabase
          .from('sections')
          .select('id', { count: 'exact' })
          .eq('term_id', termId)
          .lt('updated_at', runStamp)
          .limit(15)
        if (!error && count > 0) {
          console.log(`   ℹ️  ${count} ${label} sections were not listed today (cancelled or renumbered); left in place.`)
          console.log(`      e.g. ${data.map((r) => r.id).join(', ')}\n`)
        }
      }
    }
  } catch (err) {
    if (!(err instanceof Abort)) throw err
    abortReason = err.message
  }

  const elapsed = Date.now() - startedAt
  console.log('==================================================')
  console.log('📊 Daily Sync Summary')
  console.log('==================================================')
  console.log(`   Courses upserted:     ${stats.courses}`)
  console.log(`   Sections upserted:    ${stats.sections}`)
  console.log(`   Requests to Testudo:  ${client.requests}`)
  console.log(`   Failed departments:   ${stats.failedDepts.length}${stats.failedDepts.length ? ` (${stats.failedDepts.slice(0, 15).join(', ')})` : ''}`)
  console.log(`   Failed section reqs:  ${stats.failedChunks}`)
  console.log(`   Courses w/o sections: ${stats.missingCourses}`)
  console.log(`   Elapsed:              ${fmt(elapsed)}`)

  if (abortReason) {
    console.error(`\n🛑 Stopped early: ${abortReason}`)
    process.exitCode = 1
  } else if (stats.failedDepts.length + stats.failedChunks > 10 || stats.dbErrors > 0) {
    console.error('\n⚠️  Finished with errors.')
    process.exitCode = 1
  } else {
    console.log('\n🎉 Daily sync complete!')
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal:', err)
  process.exit(1)
})
