import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  coursesWithSections, labelToTermId, mergeSemesters, parseDepartmentCourses, parseDepartments,
  parseMetaAndDescription, parseSections, sectionType,
} from '../scripts/lib/parse.mjs'
import { resolveTerms } from '../scripts/terms.mjs'

// Fixtures are trimmed copies of live Testudo pages captured 2026-09-18.
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('department prefixes come from the term root page', () => {
  assert.deepEqual(parseDepartments(fixture('root-202701.html')), ['AAAS', 'AAST', 'ABRM', 'AGNR', 'AGST'])
})

test('course blocks parse into courses rows', () => {
  const courses = parseDepartmentCourses(fixture('dept-CMSC-202701.html'))
  const cmsc131 = courses.find((c) => c.id === 'CMSC131')
  assert.equal(cmsc131.title, 'Object-Oriented Programming I')
  assert.equal(cmsc131.credits, 4)
  assert.ok(cmsc131.description.startsWith('Introduction to programming'))
  assert.ok(!('avg_gpa' in cmsc131), 'avg_gpa belongs to the PlanetTerp job')
  assert.ok(!('semesters_offered' in cmsc131), 'semesters_offered is merged by the caller')

  const withPrereq = courses.find((c) => c.id !== 'CMSC131')
  assert.ok(withPrereq.prerequisites, 'a course with a Prerequisite: line gets one')
})

test('only courses with a Show Sections link are asked for sections', () => {
  const html = fixture('dept-CMSC-202701.html')
  assert.deepEqual([...coursesWithSections(html)].sort(), ['CMSC125', 'CMSC131'])
  // A thesis-research listing has no link and nothing scheduled.
  const noLink = html.replace('<a href="/soc/202701/CMSC/CMSC125" class="toggle-sections-link">', '<a>')
  assert.deepEqual([...coursesWithSections(noLink)], ['CMSC131'])
})

test('sections parse from the batched sections endpoint', () => {
  const byCourse = parseSections(fixture('sections-202701.html'), '202701')
  const rows = byCourse.get('CMSC131')
  assert.equal(rows.length, 2)
  const [s] = rows
  assert.equal(s.id, 'CMSC131-202701-0101')
  assert.equal(s.course_id, 'CMSC131')
  assert.equal(s.term_id, '202701')
  assert.equal(s.instructor, 'Nora Burkhauser')
  assert.equal(s.total_seats, 30)
  assert.equal(s.waitlist, 0)   // empty before registration opens
  assert.equal(s.holdfile, 0)
  assert.deepEqual(s.meeting_times[0], {
    days: 'MWF', start_time: '1:00pm', end_time: '1:50pm', building: 'IRB', room: '0324', type: 'Lecture',
  })
  assert.equal(s.meeting_times[1].type, 'Discussion')
  assert.equal(s.section_type, 'in-person')
})

test('section type follows the meeting vocabulary search_courses uses', () => {
  const inPerson = { days: 'MWF', start_time: '1:00pm', building: 'IRB', room: '0324' }
  const online = { days: 'Tu', start_time: '5:30pm', building: '', room: 'ONLINE' }
  const async = { days: 'Online', start_time: 'ASYNC', building: 'ONLINE', room: 'ELMS' }
  assert.equal(sectionType([inPerson]), 'in-person')
  assert.equal(sectionType([online]), 'online')   // the old scraper called this in-person
  assert.equal(sectionType([async]), 'async')
  assert.equal(sectionType([inPerson, async]), 'hybrid')
  assert.equal(sectionType([inPerson, online]), 'hybrid')
  assert.equal(sectionType([]), 'in-person')
})

test('semesters_offered gains the term and stays in term order', () => {
  assert.equal(labelToTermId('Winter 2027'), '202612')
  assert.deepEqual(
    mergeSemesters(['Spring 2026', 'Fall 2026'], 'Spring 2027'),
    ['Spring 2026', 'Fall 2026', 'Spring 2027'],
  )
  assert.deepEqual(mergeSemesters(['Fall 2026', 'Spring 2027'], 'Winter 2027'), ['Fall 2026', 'Winter 2027', 'Spring 2027'])
  assert.deepEqual(mergeSemesters(['Fall 2026'], 'Fall 2026'), ['Fall 2026'])
  assert.deepEqual(mergeSemesters(null, 'Spring 2027'), ['Spring 2027'])
})

test('course text splits into description and metadata fields', () => {
  const r = parseMetaAndDescription('Intro to things. Prerequisite: MATH140. Restriction: Must be in a major. Covers loops.')
  assert.equal(r.description, 'Intro to things. Covers loops.')
  assert.equal(r.prerequisites, 'MATH140.')
  assert.equal(r.restrictions, 'Must be in a major.')
})

test('terms resolve in the requested order and unknown ids fail loudly', () => {
  assert.deepEqual(resolveTerms(['202608', '202701']).map((t) => t.label), ['Fall 2026', 'Spring 2027'])
  assert.throws(() => resolveTerms(['202605']), /Unknown term/)
})
