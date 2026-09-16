/**
 * The projection warm-up: a one-pass background backfill that gives every
 * stored session its `contextActivity` + `contextTimeline` rows WITHOUT
 * waiting for the user to open it.
 *
 * The overview's heatmap, KPI band, and session cards read the session
 * list's projection column, which serves durable cache rows only (zero-I/O).
 * A session folded before a projection unit existed — `contextActivity` on
 * upgrade, `contextTimeline` for a session that predates the plugin — or
 * whose rows went version-stale (a `stateVersion` bump, e.g. the timeline's
 * `lastUser` preview) has no usable row until it next goes live, so the
 * heatmap would stay empty, the KPI band would undercount, and the cards
 * would show their no-data note and no preview indefinitely. The cache's
 * cold-read ladder (`sessionProjectionCache.coldSnapshot`) closes exactly
 * that gap: read the stored log once, seed each unit from its cached rows,
 * fold the remainder, and write the refreshed checkpoint back (the cache
 * does the write-back itself).
 *
 * OPTIONAL BY CONTRACT: the sessionQuery / sessionProjectionCache /
 * sessionPersistence / sessions services compose on every standard
 * deployment, but a deployment may strip them — the whole warm-up rides a
 * deferred inject, every face is re-proved structurally before use, and
 * each session's read is isolated (one unreadable log costs just itself,
 * logged). Live sessions are skipped: they fold every unit themselves and
 * checkpoint on the mandatory points, so a cold write would only race them.
 */

import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** The corpus listing face, as consumed (re-proved at runtime). */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

/** The cache's two cold-path verbs, as consumed. */
interface ProjectionCacheLike {
  cachedSnapshot(header: SessionHeader, inheritedEventCount: unknown, keys?: readonly string[]): unknown
  coldSnapshot(header: SessionHeader, inheritedEventCount: unknown, events: readonly SessionEvent[]): unknown
}

/** One persistence read handle, as consumed (mirrors dsh-session-query's readColdSessionLog). */
interface ReadHandleLike {
  header: SessionHeader
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
}

/** Inter-session pacing so a multi-hundred-session backfill never starve the host. */
const YIELD_MS = 10

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

/** One listed record's header, re-proved: id and cwd are the two fields the run relies on. */
function headerOf(record: unknown): SessionHeader | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as SessionHeader
}

/** Whether the cache already serves BOTH projection rows for this header (nothing to backfill). */
function servesRows(cache: ProjectionCacheLike, header: SessionHeader): boolean {
  try {
    // Unseeded sessions carry no inherited prefix (cut 0); a seeded (forked)
    // header's real cut only arrives with the log read below, so the probe
    // misses and the session takes the cold-read path — correct either way.
    // Both keys must be served: a version-stale row (the timeline's head
    // gained `lastUser` at stateVersion 20) reads as absent here, so the
    // session's stale rows get their one cold refold at startup.
    const block = asRecord(cache.cachedSnapshot(header, SessionLogOffset(0), ['contextActivity', 'contextTimeline']))
    const values = asRecord(block?.values)
    return values !== null
      && values.contextActivity !== undefined
      && values.contextTimeline !== undefined
  } catch {
    return false
  }
}

/** Read one stored log through a read handle, mirroring dsh-session-query's readColdSessionLog. */
async function readColdLog(
  persistence: PersistenceLike,
  id: string,
  signal: AbortSignal,
): Promise<{ header: SessionHeader; inheritedEventCount: unknown; events: SessionEvent[] }> {
  const handle = await persistence.open(id, 'read', { signal })
  let events: readonly SessionEvent[]
  try {
    const raw: unknown = await handle.read(0, undefined, { signal })
    // The handle's read result is re-proved: a hostile persistence serves an empty log, never a throw.
    const result = asRecord(raw)?.events
    events = Array.isArray(result) ? result : []
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch { /* the read failure is the actionable cause */ }
    throw error
  }
  await handle.close()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...interruptedTurnClosers(events)],
  }
}

/**
 * Whether one session is live (folds for itself — a cold write would only
 * race its own checkpoints). A throwing registry read conservatively skips
 * the session too: better to leave a row unfolded than to write over a
 * possibly-live one.
 */
function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return (sessions.get as (id: string) => unknown)(id) !== undefined
  } catch {
    return true
  }
}

/**
 * Arm the warm-up on whichever deployment composes the four cold-path
 * services; returns the deferred inject's disposer (abort on unload).
 */
export function watchActivityBackfill(ctx: Context): () => void {
  const fiber = ctx.inject(['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'], (raw) => {
    const injected = raw as unknown as {
      sessionQuery?: unknown
      sessionProjectionCache?: unknown
      sessionPersistence?: unknown
      sessions?: unknown
    }
    const query = asRecord(injected.sessionQuery)
    const cache = asRecord(injected.sessionProjectionCache)
    const persistence = asRecord(injected.sessionPersistence)
    if (query === null || typeof query.listSessions !== 'function') return
    if (cache === null
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.coldSnapshot !== 'function') return
    if (persistence === null || typeof persistence.open !== 'function') return
    const sessions = asRecord(injected.sessions)

    const abort = new AbortController()
    const run = async (): Promise<void> => {
      const listed = await (query as unknown as SessionQueryLike).listSessions(abort.signal)
      if (!Array.isArray(listed)) return
      let folded = 0
      for (const record of listed) {
        if (abort.signal.aborted) return
        const header = headerOf(record)
        if (header === null || typeof header.cwd !== 'string') continue
        if (isLive(sessions, header.id)) continue
        if (servesRows(cache as unknown as ProjectionCacheLike, header)) continue
        try {
          const log = await readColdLog(persistence as unknown as PersistenceLike, header.id, abort.signal)
          // The handle's header is authoritative (fixed at open); the listed
          // one was only the probe's identity witness.
          ;(cache as unknown as ProjectionCacheLike).coldSnapshot(log.header, log.inheritedEventCount, log.events)
          folded++
        } catch (error: unknown) {
          ctx.logger.warn(`dsh-context: projection backfill skipped "${header.id}" (${String(error)})`)
        }
        // Pace the pass: hundreds of cold reads in one breath would starve the host.
        await new Promise(resolve => setTimeout(resolve, YIELD_MS))
      }
      if (folded > 0) ctx.logger.info(`dsh-context: projection rows backfilled for ${folded} session(s)`)
    }
    void run().catch((error: unknown) => {
      if (!abort.signal.aborted) ctx.logger.warn(`dsh-context: projection backfill stopped early (${String(error)})`)
    })
    return () => { abort.abort() }
  })
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}
