// ─────────────────────────────────────────────────────────────────────────────
// Testudo HTML → TerrapinTunnel rows. Pure functions, no network, no DB.
//
// Three pages are parsed:
//   /soc/{termId}                          → department prefixes
//   /soc/{termId}/{DEPT}                   → course metadata (one .course each)
//   /soc/{termId}/sections?courseIds=A,B   → sections, grouped per course in
//                                            div.course-sections#{courseId}
//
// The row shapes match the `courses` and `sections` tables the website reads.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from 'cheerio'

const SEASON_MONTH = { Spring: '01', Summer: '05', Fall: '08', Winter: '12' }

// "Fall 2026" → "202608". Used to keep semesters_offered in term order.
// Winter is named for the January it ends in: "Winter 2027" is 202612.
export function labelToTermId(label) {
  const m = /^(Spring|Summer|Fall|Winter)\s+(\d{4})$/.exec(label)
  if (!m) return label
  const year = m[1] === 'Winter' ? Number(m[2]) - 1 : m[2]
  return `${year}${SEASON_MONTH[m[1]]}`
}

// Adds a semester label to an existing semesters_offered array, deduped and
// sorted chronologically. The catalog's semester filter reads this column.
export function mergeSemesters(existing, label) {
  const set = new Set(Array.isArray(existing) ? existing : [])
  set.add(label)
  return [...set].sort((a, b) => labelToTermId(a).localeCompare(labelToTermId(b)))
}

// ── Department list ─────────────────────────────────────────────────────────
export function parseDepartments(html) {
  const $ = cheerio.load(html)
  const depts = $('.prefix-abbrev')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((d) => /^[A-Z]{4}$/.test(d))
  return [...new Set(depts)]
}

// ── Course metadata ─────────────────────────────────────────────────────────
// Splits a course text block into fields by trigger keyword; everything before
// the first trigger is the description.
export function parseMetaAndDescription(text) {
  text = text.replace(/\s+/g, ' ').trim()

  const triggers = [
    { key: 'prerequisites',           pattern: /Prerequisite\s*:/i },
    { key: 'restrictions',            pattern: /Restriction\s*:/i },
    { key: 'cross_listings',          pattern: /Cross-lists?ed with/i },
    { key: 'credit_only_granted_for', pattern: /Credit only granted for/i },
    { key: 'additional_information',  pattern: /Additional information\s*:/i },
    { key: 'formerly',                pattern: /Formerly\s*:/i },
    { key: 'corequisites',            pattern: /Corequisite\s*:/i },
    { key: 'recommended',             pattern: /Recommended\s*:/i },
  ]

  const marks = []
  for (const { key, pattern } of triggers) {
    const re = new RegExp(pattern.source, 'gi')
    let m
    while ((m = re.exec(text)) !== null) marks.push({ key, start: m.index, end: m.index + m[0].length })
  }
  marks.sort((a, b) => a.start - b.start)

  const results = Object.fromEntries(triggers.map(({ key }) => [key, '']))
  results.description = text
  if (marks.length === 0) return results

  results.description = text.slice(0, marks[0].start).trim()

  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]
    const endIndex = i + 1 < marks.length ? marks[i + 1].start : text.length
    const content = text.slice(cur.end, endIndex).trim().replace(/^:/, '').trim()

    if (i === marks.length - 1) {
      // The last field can run into trailing prose; split it back off.
      const proseSplit = content.match(/\.\s+([A-Z])/)
      if (proseSplit) {
        const idx = content.indexOf(proseSplit[0])
        results[cur.key] = content.slice(0, idx + 1).trim()
        results.description = (results.description + ' ' + content.slice(idx + 1).trim()).trim()
      } else {
        results[cur.key] = content.replace(/\.$/, '').trim()
      }
    } else {
      results[cur.key] = content
    }
  }

  for (const key of Object.keys(results)) results[key] = results[key].trim().replace(/^:/, '').trim()
  return results
}

const META_FIELDS = [
  'prerequisites', 'restrictions', 'corequisites', 'recommended', 'formerly',
  'cross_listings', 'credit_only_granted_for', 'additional_information',
]

// One .course block → a `courses` row, or null when id/title is missing.
// avg_gpa and semesters_offered are deliberately absent: avg_gpa belongs to
// the PlanetTerp job, semesters_offered is merged by the caller.
function parseCourseBlock($, block) {
  const el = $(block)
  const id = el.find('.course-id').first().text().trim()
  const title = el.find('.course-title').first().text().trim()
  if (!id || !title) return null

  const minCredits = el.find('.course-min-credits').first().text().trim()
  const maxCredits = el.find('.course-max-credits').first().text().trim()

  let genEd = null
  const genEdGroup = el.find('.gen-ed-codes-group > div').first()
  if (genEdGroup.length) {
    const cloned = genEdGroup.clone()
    cloned.find('.course-info-label').remove()
    const raw = cloned.text().replace(/\s+/g, ' ').trim().replace(/^:/, '').trim()
    if (raw) genEd = raw.replace(/([A-Z]{4})\s+(?=[A-Z]{4})/g, '$1, ')
  }

  const row = {
    id,
    title,
    credits:     minCredits ? (parseInt(minCredits, 10) || null) : null,
    max_credits: maxCredits ? (parseInt(maxCredits, 10) || null) : null,
    gen_ed:      genEd,
    description: null,
    ...Object.fromEntries(META_FIELDS.map((f) => [f, null])),
  }

  const descParts = []
  el.find('.approved-course-text, .course-text').each((_, tag) => {
    const raw = $(tag).text().replace(/\s+/g, ' ').trim()
    if (!raw) return
    const extracted = parseMetaAndDescription(raw)
    for (const f of META_FIELDS) if (extracted[f]) row[f] = extracted[f]
    if (extracted.description) descParts.push(extracted.description)
  })
  row.description = descParts.join(' ').trim() || null
  return row
}

export function parseDepartmentCourses(html) {
  const $ = cheerio.load(html)
  const courses = []
  $('.course').each((_, block) => {
    const c = parseCourseBlock($, block)
    if (c) courses.push(c)
  })
  return courses
}

// ── Sections ────────────────────────────────────────────────────────────────
// Meeting-format vocabulary matches search_courses(): async is start_time
// 'ASYNC'; synchronous online is room 'ONLINE'; anything else is in person.
export function sectionType(meetings) {
  const isAsync  = (m) => m.start_time === 'ASYNC'
  const isOnline = (m) => !isAsync(m) && (m.room === 'ONLINE' || m.building === 'ONLINE')
  const kinds = new Set(meetings.map((m) => (isAsync(m) ? 'async' : isOnline(m) ? 'online' : 'in-person')))
  if (kinds.size > 1) return 'hybrid'
  return kinds.values().next().value ?? 'in-person'
}

function parseSection($, element, courseId, termId) {
  const el = $(element)
  const sectionNumber = el.find('.section-id').first().text().trim()
  if (!sectionNumber) return null

  const instructors = el.find('.section-instructor').map((_, i) => $(i).text().trim()).get().filter(Boolean)
  const int = (sel, idx = 0) => parseInt(el.find(sel).eq(idx).text().trim(), 10) || 0

  const meetings = []
  el.find('.class-days-container .row').each((_, row) => {
    const r = $(row)
    const type = r.find('.class-type').text().trim() || 'Lecture'
    if (r.text().includes('Class time/details on ELMS')) {
      meetings.push({ days: 'Online', start_time: 'ASYNC', end_time: 'ASYNC', building: 'ONLINE', room: 'ELMS', type })
      return
    }
    const m = {
      days:       r.find('.section-days').text().trim(),
      start_time: r.find('.class-start-time').text().trim(),
      end_time:   r.find('.class-end-time').text().trim(),
      building:   r.find('.building-code').text().trim(),
      room:       r.find('.class-room').text().trim(),
      type,
    }
    if (m.days || m.start_time || m.room) meetings.push(m)
  })

  return {
    id:             `${courseId}-${termId}-${sectionNumber}`,
    course_id:      courseId,
    term_id:        termId,
    section_number: sectionNumber,
    instructor:     instructors.length ? instructors.join(' / ') : 'TBA',
    open_seats:     int('.open-seats-count'),
    total_seats:    int('.total-seats-count'),
    // Testudo renders waitlist and holdfile with the same class, in that order.
    waitlist:       int('.waitlist-count', 0),
    holdfile:       int('.waitlist-count', 1),
    meeting_times:  meetings,
    section_type:   sectionType(meetings),
  }
}

// Returns Map<courseId, sectionRow[]> — every requested course that Testudo
// answered for, including ones with zero sections.
export function parseSections(html, termId) {
  const $ = cheerio.load(html)
  const byCourse = new Map()
  $('.course-sections').each((_, block) => {
    const courseId = $(block).attr('id')?.trim()
    if (!courseId) return
    const rows = []
    $(block).find('.section').each((_, s) => {
      const row = parseSection($, s, courseId, termId)
      if (row) rows.push(row)
    })
    byCourse.set(courseId, rows)
  })
  return byCourse
}
