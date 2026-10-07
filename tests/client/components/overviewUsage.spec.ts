// The first row's usage chart (src/client/components/overviewUsage.tsx):
// the fixed last-7-days window off the injected today key, the two series'
// independent maxima, bar heights, the tick rails and gridlines framed off
// the same maxima, unpriced/zero days, and the empty and degraded paths —
// rendered with real React.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewUsage, usageWindowOf } from '../../../src/client/components/overviewUsage'
import type { DayTotals } from '../../../src/client/overview'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const OverviewUsage = makeOverviewUsage(kit)

// 2026-09-16 was a Wednesday; the window is its seven-day tail.
const TODAY = '2026-09-16'

function day(over: Partial<DayTotals> = {}): DayTotals {
  return { tokens: 0, requests: 0, sessions: 0, cost: null, ...over }
}

describe('usageWindowOf', () => {
  test('walks today and the six days before it, oldest first', () => {
    assert.deepEqual(usageWindowOf(TODAY), [
      '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16',
    ])
  })

  test('a corrupt today key reads as an empty window (the card degrades to its note)', () => {
    assert.deepEqual(usageWindowOf('junk'), [])
  })
})

describe('OverviewUsage', () => {
  test('an all-empty window renders the empty note, no bars', async () => {
    const m = await mount(h(OverviewUsage, { days: {}, currency: 'usd', today: TODAY }))
    assert.ok(text(m.container).includes('No usage in the last 7 days'))
    assert.equal(queryAll(m.container, '.lc-ov-usage-bar').length, 0)
    await m.unmount()
  })

  test('a corrupt today key degrades to the empty note', async () => {
    const m = await mount(h(OverviewUsage, { days: { '2026-09-16': day({ tokens: 5 }) }, currency: 'usd', today: 'junk' }))
    assert.ok(text(m.container).includes('No usage in the last 7 days'))
    await m.unmount()
  })

  test('seven columns draw, out-of-window days are ignored, and the key names both series', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1200, cost: 0.5 }),
        '2026-09-10': day({ tokens: 300 }),
        '2026-09-09': day({ tokens: 999_999 }),
        '2026-09-01': day({ tokens: 50_000_000 }),
      },
      currency: 'usd',
      today: TODAY,
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
    const days = queryAll(m.container, '.lc-ov-usage-day').map(el => el.textContent)
    assert.deepEqual(days, ['09-10', '09-11', '09-12', '09-13', '09-14', '09-15', '09-16'])
    assert.ok(text(m.container).includes('Tokens'))
    assert.ok(text(m.container).includes('Cost'))
    await m.unmount()
  })

  test('bar heights scale on each series’ OWN window maximum, with a floor for tiny days', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000, cost: 1 }),
        '2026-09-15': day({ tokens: 100, cost: 0.5 }),
        '2026-09-14': day({ tokens: 1, cost: 0.01 }),
      },
      currency: 'usd',
      today: TODAY,
    }))
    const heightOf = (col: number, cls: string): string =>
      (queryAll(m.container, '.lc-ov-usage-col')[col].querySelector('.' + cls) as HTMLElement).style.height
    // Columns run oldest first: 09-16 (col 6) holds both series' maxima,
    // 09-15 (col 5) half-ish, 09-14 (col 4) the slivers under the 4% floor.
    assert.equal(heightOf(6, 'lc-ov-usage-tokens'), '100%')
    assert.equal(heightOf(5, 'lc-ov-usage-tokens'), '10%')
    assert.equal(heightOf(4, 'lc-ov-usage-tokens'), '4%')
    // Cost scales independently: 1 → 100%, 0.5 → 50%, 0.01 → 4%.
    assert.equal(heightOf(6, 'lc-ov-usage-cost'), '100%')
    assert.equal(heightOf(5, 'lc-ov-usage-cost'), '50%')
    assert.equal(heightOf(4, 'lc-ov-usage-cost'), '4%')
    await m.unmount()
  })

  test('the frame: five gridlines with a solid baseline, and tick rails off the same maxima', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000, cost: 1 }),
        '2026-09-15': day({ tokens: 250, cost: 0.25 }),
      },
      currency: 'usd',
      today: TODAY,
    }))
    // Five hairlines, the 0 one solid (the baseline).
    assert.equal(queryAll(m.container, '.lc-ov-usage-line').length, 5)
    assert.ok(query(m.container, '.lc-ov-usage-line-0') !== null)
    const baseline = query(m.container, '.lc-ov-usage-line-0') as HTMLElement
    assert.equal(baseline.style.bottom, '0%')
    // Left rail: the tokens peak's quarters; right rail: the cost peak's.
    const left = queryAll(m.container, '.lc-ov-usage-rail-l .lc-ov-usage-tick').map(el => el.textContent)
    const right = queryAll(m.container, '.lc-ov-usage-rail-r .lc-ov-usage-tick').map(el => el.textContent)
    assert.deepEqual(left, ['0', '250', '500', '750', '1.0k'])
    assert.deepEqual(right, ['0', '$0.25', '$0.50', '$0.75', '$1.00'])
    await m.unmount()
  })

  test('an unpriced window reads the cost rail as dashes; the bars stay', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 500, cost: null }) },
      currency: 'usd',
      today: TODAY,
    }))
    const right = queryAll(m.container, '.lc-ov-usage-rail-r .lc-ov-usage-tick').map(el => el.textContent)
    assert.deepEqual(right, ['—', '—', '—', '—', '—'])
    const col = queryAll(m.container, '.lc-ov-usage-col')[6]
    assert.equal((col.querySelector('.lc-ov-usage-tokens') as HTMLElement).style.height, '100%')
    assert.equal((col.querySelector('.lc-ov-usage-cost') as HTMLElement).style.height, '0%')
    await m.unmount()
  })

  test('a priced-but-free day draws no bars yet keeps the column (not the empty note)', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 0, requests: 2, cost: 0 }) },
      currency: 'usd',
      today: TODAY,
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
    assert.equal(text(m.container).includes('No usage in the last 7 days'), false)
    await m.unmount()
  })
})
