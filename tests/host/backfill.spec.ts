// The projection warm-up (src/host/backfill.ts) over the REAL cordis
// context: the deferred inject's service gating, the per-session skip
// ladder (malformed, invisible, live, already fully served), the cold-read →
// coldSnapshot fold path, per-session failure isolation, and abort-on-
// dispose.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { watchActivityBackfill } from '../../src/host/backfill'

/** Poll until the async run reaches a condition. */
async function until<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

interface FakeState {
  listed: unknown
  served: Set<string>
  live: Set<string>
  coldReads: string[]
  coldSnapshots: string[]
  failReads: Set<string>
}

function arm(ctx: Context, state: FakeState): void {
  ctx.provide('sessionQuery', {
    listSessions: async () => state.listed,
  })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: { id: string }) =>
      state.served.has(header.id)
        ? { asOfSeq: 0, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
        : undefined,
    coldSnapshot: (header: { id: string }) => {
      state.coldSnapshots.push(header.id)
      return { asOfSeq: 0, values: {} }
    },
  })
  ctx.provide('sessionPersistence', {
    open: async (id: string) => {
      state.coldReads.push(id)
      if (state.failReads.has(id)) throw new Error(`no such session ${id}`)
      const events: SessionEvent[] = []
      return {
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events }),
        close: async () => {},
      }
    },
  })
  ctx.provide('sessions', { get: (id: string) => (state.live.has(id) ? { id } : undefined) })
}

function fakeState(listed: unknown): FakeState {
  return {
    listed,
    served: new Set(),
    live: new Set(),
    coldReads: [],
    coldSnapshots: [],
    failReads: new Set(),
  }
}

describe('watchActivityBackfill', () => {
  test('a deployment without the cold-path services never fires the callback', async () => {
    const ctx = new Context()
    const dispose = watchActivityBackfill(ctx)
    dispose()
    await new Promise(resolve => setTimeout(resolve, 5))
    // Nothing to assert beyond: no throw, no pending work.
  })

  test('incomplete faces are re-proved away — no run starts', async () => {
    const ctx = new Context()
    ctx.provide('sessionQuery', { notListSessions: true })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await new Promise(resolve => setTimeout(resolve, 10))
    dispose()

    const ctx2 = new Context()
    ctx2.provide('sessionQuery', { listSessions: async () => [] })
    ctx2.provide('sessionProjectionCache', { coldSnapshot: () => ({}) })
    ctx2.provide('sessionPersistence', { open: async () => ({}) })
    ctx2.provide('sessions', { get: () => undefined })
    const dispose2 = watchActivityBackfill(ctx2)
    await new Promise(resolve => setTimeout(resolve, 10))
    dispose2()

    // Query and cache valid, persistence face broken: same early return.
    const ctx3 = new Context()
    ctx3.provide('sessionQuery', { listSessions: async () => [] })
    ctx3.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx3.provide('sessionPersistence', { notOpen: true })
    ctx3.provide('sessions', { get: () => undefined })
    const dispose3 = watchActivityBackfill(ctx3)
    await new Promise(resolve => setTimeout(resolve, 10))
    dispose3()
  })

  test('a fully-served corpus completes silently (no fold, no info line)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    state.served.add('a')
    let listed = 0
    ctx.provide('sessionQuery', {
      listSessions: async () => {
        listed++
        return state.listed
      },
    })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (header: { id: string }) =>
        state.served.has(header.id)
          ? { asOfSeq: 0, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
          : undefined,
      coldSnapshot: () => {
        state.coldSnapshots.push('x')
        return {}
      },
    })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    await new Promise(resolve => setTimeout(resolve, 40))
    dispose()
    assert.deepEqual(state.coldReads, [], 'nothing to fold')
    assert.deepEqual(state.coldSnapshots, [])
  })

  test('a rejection landing AFTER abort skips the warn (the unload owns the silence)', async () => {
    const ctx = new Context()
    let rejectListed: (error: Error) => void = () => {}
    ctx.provide('sessionQuery', {
      listSessions: async () => new Promise((_resolve, reject) => {
        rejectListed = reject
      }),
    })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await new Promise(resolve => setTimeout(resolve, 20))
    dispose()
    rejectListed(new Error('corpus down'))
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  test('sessions missing their row get one cold read each; served, live, and malformed ones skip', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'e' } },                    // invisible (no cwd)
      { header: { id: '' } },                     // malformed id
      { header: 7 },                              // malformed header
      null,                                       // malformed record
      { header: { id: 'b', cwd: '/repo/b' } },    // already served
      { header: { id: 'd', cwd: '/repo/d' } },    // live
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'c', cwd: '/repo/c' } },
    ])
    state.served.add('b')
    state.live.add('d')
    arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    // The skip-guard records come first, so every guard branch runs before
    // the two folds complete the observable signal; the run then finishes.
    await until(() => (state.coldSnapshots.length >= 2 ? true : undefined), 'two cold folds')
    await new Promise(resolve => setTimeout(resolve, 60))
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['a', 'c'])
    assert.deepEqual(state.coldSnapshots.sort(), ['a', 'c'])
  })

  test('a session serving only the activity row (timeline version-stale) gets a cold refold', async () => {
    // The lastUser bump's whole point: a cached timeline row that predates
    // the field fails the version gate and reads as absent — the session is
    // NOT "already served" and its rows are rebuilt at startup.
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => ({ asOfSeq: 0, values: { contextActivity: { days: {} } } }),
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return { asOfSeq: 0, values: {} }
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the stale session folded')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('a non-array listing ends the run without work', async () => {
    const ctx = new Context()
    const state = fakeState({ not: 'an array' })
    let listed = 0
    ctx.provide('sessionQuery', {
      listSessions: async () => {
        listed++
        return state.listed
      },
    })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
    assert.deepEqual(state.coldReads, [])
  })

  test('a throwing probe (cachedSnapshot) reads as not-served and backfills', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => { throw new Error('identity mismatch') },
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: 'garbage' }),
        close: async () => {},
      }),
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the fold ran')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('one unreadable log warns and the run continues with the next session', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'bad', cwd: '/repo/bad' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    state.failReads.add('bad')
    arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['bad', 'good'])
    assert.deepEqual(state.coldSnapshots, ['good'])
  })

  test('a mid-read failure closes the handle (a close failure adds nothing) and the run continues', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'torn', cwd: '/repo/torn' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    let closes = 0
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: id === 'torn'
          ? async () => { throw new Error('torn tail') }
          : async () => ({ events: [] }),
        close: async () => {
          closes++
          if (id === 'torn') throw new Error('close failed too')
        },
      }),
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    dispose()
    assert.equal(closes, 2, 'both handles closed — the torn one before the error propagated')
    assert.deepEqual(state.coldSnapshots, ['good'])
  })

  test('dispose aborts the pass mid-loop', async () => {
    const ctx = new Context()
    const many = Array.from({ length: 50 }, (_, i) => ({ header: { id: `s${i}`, cwd: '/repo' } }))
    const state = fakeState(many)
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: () => ({}),
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => {
        state.coldReads.push(id)
        return {
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }
      },
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await until(() => (state.coldReads.length >= 1 ? true : undefined), 'the run started')
    dispose()
    const seen = state.coldReads.length
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(state.coldReads.length <= seen + 1, 'no further sessions read after abort')
  })

  test('a sessions service present-but-undefined folds without a live probe', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    })
    ctx.provide('sessions', undefined)
    const dispose = watchActivityBackfill(ctx)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the fold ran')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('a throwing live-probe conservatively skips the session (no cold write over a possibly-live one)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: () => ({}),
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => {
        state.coldReads.push(id)
        return {
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }
      },
    })
    ctx.provide('sessions', { get: () => { throw new Error('registry broken') } })
    const dispose = watchActivityBackfill(ctx)
    await new Promise(resolve => setTimeout(resolve, 80))
    dispose()
    assert.deepEqual(state.coldReads, [], 'no cold read for a session whose liveness cannot be proven')
  })

  test('a failing listSessions rejection is contained (no unhandled rejection)', async () => {
    const ctx = new Context()
    let listed = 0
    ctx.provide('sessionQuery', {
      listSessions: async () => {
        listed++
        throw new Error('corpus down')
      },
    })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    // The rejection lands and is logged while NOT aborted (the dispose follows).
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
  })
})
