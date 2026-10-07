/**
 * The host-wide cold-read governor (issue #121).
 *
 * Every cold read — the warm-up pass's per-session fold (backfill.ts) and
 * the detail route's cold rung (detail.ts) — materializes one session's
 * whole durable log: the persistence backend decodes every frame before it
 * can slice a single event, so a 10k-event session lands as a several-
 * hundred-MB object graph, and the harness pins its own floors on top (the
 * backend's two-entry decoded-log memo, the observation reader's five-entry
 * prepared-session cache). Those floors are the harness's to tune; what the
 * PLUGIN owns is how many of its cold reads run at once and whether a new
 * one starts on an already-hot heap. Before this gate the answer to both
 * was "unbounded": the dashboard's first open fires the corpus pass and the
 * session cards' / Agent network's per-session detail fan-out together, and
 * on a capped-heap host (an Electron main whose V8 ceiling cannot move)
 * that stacking was enough to push the process over its limit.
 *
 * The gate therefore admits one cold read at a time (FIFO) and only while
 * the heap leaves headroom for it. A skipped read never fails visibly: the
 * pass stops early (its folded rows persist; the rest refold on their next
 * live activity or a later process's pass) and the detail route answers its
 * typed null (the client keeps its last detail, the cards their no-data
 * note) — every degradation already designed, no functionality removed.
 */

import { getHeapStatistics } from 'node:v8'

/** One heap-headroom reading: bytes in use against the process's own V8 ceiling. */
export interface HeapReading {
  used: number
  limit: number
}

/** The admission face both cold paths share. */
export interface ColdReadGate {
  /**
   * Run one cold read once every earlier read has settled, when the heap
   * leaves headroom for it; `undefined` when the read was skipped under
   * pressure — the caller's own no-data path answers instead.
   */
  admit<T>(read: () => Promise<T>): Promise<T | undefined>
}

/**
 * The high-water mark as a fraction of the process's own heap ceiling: a
 * cold read starts only below two-thirds full, leaving the top third for
 * the read itself plus the harness's floors. The ceiling is V8's real
 * limit, so every host class — a default-heap CLI, a capped Electron
 * main — gets its own mark from the same constant.
 */
const HIGH_WATER = 2 / 3

/** The process's own V8 reading. */
function v8Reading(): HeapReading {
  const stats = getHeapStatistics()
  return { used: stats.used_heap_size, limit: stats.heap_size_limit }
}

const noop = (): void => {}

/**
 * One governor per host process, shared by both cold paths. `reading` is
 * injectable for tests; a throwing or garbage probe fails OPEN — the meter
 * must never block a read (the version probe's philosophy).
 */
export function makeColdReadGate(reading: () => HeapReading = v8Reading): ColdReadGate {
  const clear = (): boolean => {
    try {
      const { used, limit } = reading()
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return true
      return used < limit * HIGH_WATER
    } catch {
      return true
    }
  }
  let tail: Promise<unknown> = Promise.resolve()
  return {
    admit<T>(read: () => Promise<T>): Promise<T | undefined> {
      // The headroom check runs when the read reaches the front of the
      // queue, not when it was queued — pressure changes while waiting.
      const run = tail.then(() => (clear() ? read() : undefined))
      tail = run.then(noop, noop)
      return run
    },
  }
}
