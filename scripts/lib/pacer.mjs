// ─────────────────────────────────────────────────────────────────────────────
// Pacer — spreads a known-ish number of requests across a time budget.
//
// Instead of a fixed delay, every gap is drawn around
//     mean = time left until the target / requests still to make
// so the run stretches to fill the window whatever the real request count is,
// and recovers on its own after a slow response or a backoff.
//
// Each gap is jittered with a log-normal factor (mean 1): most gaps sit near
// the mean, some are short, a few are long. Occasionally a much longer pause
// is taken, the way a person browsing wanders off. The adaptive mean pays
// those pauses back by tightening the gaps after them.
// ─────────────────────────────────────────────────────────────────────────────

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Standard normal via Box–Muller.
function gaussian(rand = Math.random) {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

// Log-normal factor with expected value 1.
export function jitterFactor(sigma = 0.55, rand = Math.random) {
  return Math.exp(sigma * gaussian(rand) - (sigma * sigma) / 2)
}

export class Pacer {
  /**
   * @param {object} o
   * @param {number} o.targetMs     aim to make the last request by now + targetMs
   * @param {number} o.minGapMs     never go faster than this, even when behind
   * @param {number} o.maxGapMs     cap on an ordinary gap
   * @param {number} o.breakChance  probability a gap becomes a long pause
   * @param {number} o.maxBreakMs   cap on a long pause
   */
  constructor({ targetMs, minGapMs, maxGapMs, breakChance = 0.03, maxBreakMs = 8 * 60_000, now = Date.now }) {
    this.now = now
    this.deadline = now() + targetMs
    this.minGapMs = minGapMs
    this.maxGapMs = maxGapMs
    this.breakChance = breakChance
    this.maxBreakMs = maxBreakMs
  }

  nextGap(remainingRequests, rand = Math.random) {
    const left = this.deadline - this.now()
    const mean = Math.max(this.minGapMs, left / Math.max(1, remainingRequests))

    if (rand() < this.breakChance && left > mean * 10) {
      return Math.min(this.maxBreakMs, mean * (4 + rand() * 4))
    }
    const gap = mean * jitterFactor(0.55, rand)
    return Math.round(Math.min(this.maxGapMs, Math.max(this.minGapMs, gap)))
  }

  async wait(remainingRequests) {
    const gap = this.nextGap(remainingRequests)
    await sleep(gap)
    return gap
  }
}
