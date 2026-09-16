// The Context Dashboard's sidebar-foot entry (src/client/components/
// overviewButton.tsx): wide/rail rendering, the running badge, the store
// flip on click, and the per-user insights-entry toggle.

import { createElement as h, act } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { makeOverviewButton } from '../../../src/client/components/overviewButton'
import { overviewStore } from '../../../src/client/overviewStore'
import { createContextSettings } from '../../../src/client/settings'
import { click, makeKit, mount, query, queryAll } from '../helpers/kit'

const kit = makeKit()
const Button = makeOverviewButton(kit)

afterEach(() => {
  overviewStore.set(false)
})

/** A useSessions stand-in over a static snapshot. */
const useSessionsOf = (snapshot: unknown) => (<T>(sel: (s: unknown) => T): T => sel(snapshot))

describe('OverviewButton', () => {
  test('the wide column renders icon and label; the rail renders the icon alone', async () => {
    const wide = await mount(h(Button, { wide: true }))
    assert.equal(query(wide.container, '.lc-ov-entry-label').textContent, 'Context Insights')
    assert.equal(query(wide.container, 'button.lc-ov-entry').getAttribute('aria-label'), 'Context Insights')
    assert.equal(queryAll(wide.container, '.lc-ov-entry-rail').length, 0)
    await wide.unmount()

    const rail = await mount(h(Button, { wide: false }))
    assert.equal(queryAll(rail.container, '.lc-ov-entry-label').length, 0)
    assert.ok(query(rail.container, '.lc-ov-entry-icon'))
    assert.ok(query(rail.container, 'button.lc-ov-entry-rail'))
    await rail.unmount()

    // An absent wide flag (a foreign owner) keeps the label hidden.
    const bare = await mount(h(Button, {}))
    assert.equal(queryAll(bare.container, '.lc-ov-entry-label').length, 0)
    assert.ok(query(bare.container, 'button.lc-ov-entry-rail'))
    await bare.unmount()
  })

  test('the badge counts running sessions and hides at zero', async () => {
    const running = useSessionsOf({ byId: { a: { running: true }, b: { running: false }, c: { running: true } } })
    const m = await mount(h(Button, { wide: true, useSessions: running }))
    assert.equal(query(m.container, '.lc-ov-badge').textContent, '2')
    await m.unmount()

    const idle = useSessionsOf({ byId: { a: { running: false } } })
    const calm = await mount(h(Button, { wide: true, useSessions: idle }))
    assert.equal(queryAll(calm.container, '.lc-ov-badge').length, 0)
    await calm.unmount()

    // No sessions seat at all: no badge, no throw.
    const seatless = await mount(h(Button, { wide: true }))
    assert.equal(queryAll(seatless.container, '.lc-ov-badge').length, 0)
    await seatless.unmount()
  })

  test('clicking opens the overview through the shared store', async () => {
    assert.equal(overviewStore.getSnapshot(), false)
    const m = await mount(h(Button, { wide: true }))
    await click(query(m.container, 'button.lc-ov-entry'))
    assert.equal(overviewStore.getSnapshot(), true)
    await m.unmount()
  })

  test('the zh locale renders the translated label', async () => {
    const ZhButton = makeOverviewButton(makeKit('zh'))
    const m = await mount(h(ZhButton, { wide: true }))
    assert.equal(query(m.container, '.lc-ov-entry-label').textContent, '上下文洞察')
    await m.unmount()
  })

  test('the insights-entry toggle takes the button down and back live', async () => {
    // The real store: a local echo flips the rendering without a scope.
    const settings = createContextSettings()
    const Toggled = makeOverviewButton(kit, settings)
    const m = await mount(h(Toggled, { wide: true }))
    assert.ok(query(m.container, 'button.lc-ov-entry'), 'the default (show) renders the entry')

    await act(async () => { settings.set('insightsEntry', 'hide') })
    assert.equal(queryAll(m.container, 'button.lc-ov-entry').length, 0, 'hide renders nothing')

    await act(async () => { settings.set('insightsEntry', 'show') })
    assert.ok(query(m.container, 'button.lc-ov-entry'), 'flipping back restores the entry')
    await m.unmount()
  })

  test('an unpersisted hide (a rejected write) rolls back to a visible entry', async () => {
    // The fail-open contract, end to end: a settings store whose scope died
    // before the write landed must not leave the entry hidden. The rejection
    // is held back so the optimistic echo is observable on its own.
    const settings = createContextSettings()
    const Toggled = makeOverviewButton(kit, settings)
    let rejectSet: ((err: unknown) => void) | undefined
    settings.attach({
      getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
      subscribe: () => () => {},
      set: () => new Promise((_, reject) => { rejectSet = reject }),
    })
    const m = await mount(h(Toggled, { wide: true }))
    await act(async () => { settings.set('insightsEntry', 'hide') })
    assert.equal(queryAll(m.container, 'button.lc-ov-entry').length, 0, 'the optimistic echo hides first')
    await act(async () => { rejectSet?.(new Error('transport down')) })
    assert.ok(query(m.container, 'button.lc-ov-entry'), 'the rollback restores the entry')
    await m.unmount()
  })
})
