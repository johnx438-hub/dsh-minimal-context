import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CALIBRATOR_ALPHA,
  DEFAULT_SCALE_MIN,
  DEFAULT_SCALE_MAX,
  DEFAULT_MIN_RAW,
  ratioSample,
  ewmaUpdate,
  TokenCalibrator,
  readInputTokensFromUsage,
} from '../src/token-calibrator.ts'

test('ratioSample: valid ratio, filtered below minRaw', () => {
  assert.equal(ratioSample(1000, 2000), 2)
  assert.equal(ratioSample(100, 200), undefined) // raw < minRaw(256)
  assert.equal(ratioSample(0, 100), undefined)
  assert.equal(ratioSample(1000, 0), undefined) // actual <= 0
  assert.equal(ratioSample(NaN, 200), undefined)
  assert.equal(ratioSample(1000, Infinity), undefined)
})

test('ewmaUpdate: smooths and clamps', () => {
  // alpha=1 → straight sample
  assert.equal(ewmaUpdate(1, 2, 1, DEFAULT_SCALE_MIN, DEFAULT_SCALE_MAX), 2)
  // alpha=0 → keep prev
  assert.equal(ewmaUpdate(1.5, 2, 0, DEFAULT_SCALE_MIN, DEFAULT_SCALE_MAX), 1.5)
  // clamp max (alpha=1 → sample 5 clamps to 2)
  assert.equal(ewmaUpdate(1, 5, 1, DEFAULT_SCALE_MIN, DEFAULT_SCALE_MAX), 2)
  // clamp min (alpha=1 → sample 0.1 clamps to 0.5)
  assert.equal(ewmaUpdate(1, 0.1, 1, DEFAULT_SCALE_MIN, DEFAULT_SCALE_MAX), 0.5)
  // invalid alpha falls back to default
  const r = ewmaUpdate(1, 2, NaN, 0.5, 2)
  assert.ok(Math.abs(r - (1 + DEFAULT_CALIBRATOR_ALPHA)) < 1e-9, `got ${r}`)
})

test('TokenCalibrator: default scale=1, apply is identity-ish', () => {
  const cal = new TokenCalibrator()
  assert.equal(cal.getScale(), 1)
  assert.equal(cal.apply(100), 100)
  assert.equal(cal.apply(0), 0)
  assert.equal(cal.apply(-5), 0)
})

test('TokenCalibrator: observe updates scale via EWMA', () => {
  const cal = new TokenCalibrator()
  cal.observe(1000, 2000) // ratio 2, EWMA alpha=0.3 → 0.3*2 + 0.7*1 = 1.3
  const sc = cal.getScale()
  assert.ok(Math.abs(sc - 1.3) < 1e-9, `scale=${sc}`)
  assert.equal(cal.snapshot().samples, 1)
  assert.equal(cal.apply(1000), 1300)
})

test('TokenCalibrator: invalid samples ignored', () => {
  const cal = new TokenCalibrator()
  cal.observe(100, 200) // raw < minRaw → ignored
  assert.equal(cal.getScale(), 1)
  assert.equal(cal.snapshot().samples, 0)
  cal.observe(NaN, 200)
  assert.equal(cal.getScale(), 1)
})

test('TokenCalibrator: clamps scale to bounds over many samples', () => {
  const cal = new TokenCalibrator()
  for (let i = 0; i < 50; i++) cal.observe(1000, 5000) // ratio 5 → clamp 2
  assert.equal(cal.getScale(), DEFAULT_SCALE_MAX)
  const cal2 = new TokenCalibrator()
  for (let i = 0; i < 50; i++) cal2.observe(1000, 100) // ratio 0.1 → clamp 0.5
  assert.equal(cal2.getScale(), DEFAULT_SCALE_MIN)
})

test('TokenCalibrator: reset restores defaults', () => {
  const cal = new TokenCalibrator()
  cal.observe(1000, 3000)
  assert.notEqual(cal.getScale(), 1)
  cal.reset()
  assert.equal(cal.getScale(), 1)
  assert.equal(cal.snapshot().samples, 0)
})

test('TokenCalibrator: options respected', () => {
  const cal = new TokenCalibrator({ alpha: 1, min: 0.1, max: 10, minRaw: 10 })
  cal.observe(50, 500) // ratio 10, alpha=1 → exact 10
  assert.equal(cal.getScale(), 10)
  assert.equal(cal.apply(100), 1000)
})

test('readInputTokensFromUsage: DSH usage chunk shape', () => {
  assert.equal(readInputTokensFromUsage({ inputTokens: 7003, outputTokens: 652 }), 7003)
  assert.equal(readInputTokensFromUsage({ inputTokens: 0 }), 0)
  assert.equal(readInputTokensFromUsage({ inputTokens: 'x' }), undefined)
  assert.equal(readInputTokensFromUsage(null), undefined)
  assert.equal(readInputTokensFromUsage(undefined), undefined)
  assert.equal(readInputTokensFromUsage({}), undefined)
  assert.equal(readInputTokensFromUsage([1, 2]), undefined)
})

test('readInputTokensFromUsage: floors floats', () => {
  assert.equal(readInputTokensFromUsage({ inputTokens: 100.9 }), 100)
})
