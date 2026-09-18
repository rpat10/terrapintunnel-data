// Terms the sync knows how to label. The label is written into
// courses.semesters_offered, which the website's catalog semester filter
// matches on, so it must equal the key in TerrapinTunnel's src/lib/terms.ts
// TERM_MAP for the same term id. Labels follow Testudo's own term picker
// (https://app.testudo.umd.edu/soc/): 202612 is "Winter 2027".
export const TERMS = {
  '202608': 'Fall 2026',
  '202612': 'Winter 2027',
  '202701': 'Spring 2027',
}

// What the daily cron refreshes, in this order. Update when Testudo publishes
// a new term, and drop a term once students have moved on from it.
export const DAILY_TERM_IDS = ['202701', '202612']

export function resolveTerms(ids) {
  return ids.map((termId) => {
    const label = TERMS[termId]
    if (!label) throw new Error(`Unknown term ${termId} — add it to TERMS in scripts/terms.mjs`)
    return { termId, label }
  })
}
