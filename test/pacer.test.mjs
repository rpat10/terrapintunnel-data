import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pacer, jitterFactor } from '../scripts/lib/pacer.mjs'

test('jitter factor averages to 1', () => {
  let sum = 0
  for (let i = 0; i < 20_000; i++) sum += jitterFactor()
  assert.ok(Math.abs(sum / 20_000 - 1) < 0.03)
})

test('gaps stretch the remaining requests across the remaining time', () => {
  const now = () => 0
  const pacer = new Pacer({ targetMs: 5 * 3_600_000, minGapMs: 4_000, maxGapMs: 180_000, breakChance: 0, now })
  let total = 0
  const n = 1_000
  for (let i = 0; i < n; i++) total += pacer.nextGap(n)
  const mean = total / n
  assert.ok(mean > 15_000 && mean < 21_000, `mean gap ${mean}ms, expected ≈18s`)
})

test('a late run never drops below the minimum gap', () => {
  const pacer = new Pacer({ targetMs: 0, minGapMs: 4_000, maxGapMs: 180_000, breakChance: 0, now: () => 0 })
  for (let i = 0; i < 500; i++) assert.ok(pacer.nextGap(1_000) >= 4_000)
})
