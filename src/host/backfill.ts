/**
 * The projection warm-up: a one-pass background backfill that gives every stored session its
 * `contextActivity` + `contextTimeline` rows, run on demand by its only reader.
 *
 * The session list serves durable cache rows only, so a session folded before a unit existed,
 * or whose rows went version-stale, has no usable row until it next goes live: the heatmap
 * stays empty and the cards keep their no-data note. The cache's cold-read ladder
 * (`sessionProjectionCache.coldSnapshot`) closes that gap — read the stored log once, seed each
 * unit from its cached rows, fold the remainder, write the refreshed checkpoint back.
 *
 * The pass runs when the client POSTs the trigger route on the Context Insights page's first open,
 * not at boot: an at-startup pass would cold-read the whole corpus on every boot whether the page
 * is ever opened or not. It runs once per process and skips live sessions, which fold for
 * themselves.
 *
 * OPTIONAL BY CONTRACT: deferred injects, every face re-proved before use, each session's read
 * isolated — a deployment without the connection route or the cold-path services never arms the
 * pass. A log the harness refuses to migrate is permanent, so its per-session detail drops to
 * debug and the pass ends with one summary info line.
 */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** The plugin's warm-up trigger route, under the authenticated `/api` fence. */
export const BACKFILL_ROUTE = '/api/dsh-context/backfill'

/** The corpus listing face, as consumed. */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

/** The cache's two cold-path verbs, as consumed (re-proved at runtime). */
interface ProjectionCacheLike {
  cachedSnapshot(meta: SessionHeader, keys?: readonly string[]): unknown
  coldSnapshot(header: SessionHeader, inheritedEventCount: unknown, events: readonly SessionEvent[]): unknown
}

/** One persistence read handle, as consumed. */
interface ReadHandleLike {
  header: SessionHeader
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
}

/** Inter-session pacing: each cold read is a full log decode, and a boot-time host under
 * sustained read pressure stalls its own client handshake. */
const YIELD_MS = 100

/** The `name` family dsh raises for a durable log it cannot interpret: the persistence seam
 * translates the format edge's refusal into `SessionFormatUnsupportedError`, so classify by prefix and import no dsh symbol. */
const UNSUPPORTED_FORMAT = 'SessionFormatUnsupported'

function headerOf(record: unknown): SessionHeader | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as SessionHeader
}

const PROBE_KEYS = ['contextActivity', 'contextTimeline']

function servesRows(cache: ProjectionCacheLike, header: SessionHeader): boolean {
  try {
    // Unseeded sessions carry no inherited prefix (cut 0), and a seeded header's real cut only
    // arrives with the log read below, so the probe misses and the session takes the cold-read
    // path. A version-stale row also reads as absent; a hostile face's throw does the same.
    const block = asRecord(cache.cachedSnapshot(header, PROBE_KEYS))
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
    // A hostile persistence result serves an empty log, never a throw.
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

/** Whether one session is live (folds for itself — a cold write would only
 * race its own checkpoints). A throwing registry read conservatively skips
 * the session too: better to leave a row unfolded than to write over a possibly-live one. */
function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return (sessions.get as (id: string) => unknown)(id) !== undefined
  } catch {
    return true
  }
}

function isUnsupportedFormat(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT)
  } catch {
    return false
  }
}

/** Printable form — a hostile error may throw on its own toString. */
function messageOf(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/** Arm the warm-up behind its trigger route: the route flips `requested` on the page's
 * first open and the cold-path faces compose `launch`; whichever lands second launches the one
 * pass. Returns the deferred injects' disposer (abort on unload). */
export function watchActivityBackfill(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): () => void {
  let requested = false
  let started = false
  let launch: (() => void) | null = null
  const tryLaunch = (): void => {
    if (!requested || started || launch === null) return
    started = true
    launch()
  }

  const routeFiber = ctx.inject(['connection'], (c) => {
    const handler = () => {
      requested = true
      tryLaunch()
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, BACKFILL_ROUTE, handler, 'dsh-context: backfill route')
  })

  const runnerFiber = ctx.inject(['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'], (raw) => {
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
      let refused = 0
      let paused = false
      for (const record of listed) {
        if (abort.signal.aborted) return
        const header = headerOf(record)
        if (header === null || typeof header.cwd !== 'string') continue
        if (isLive(sessions, header.id)) continue
        if (servesRows(cache as unknown as ProjectionCacheLike, header)) continue
        try {
          const admitted = await coldReads.admit(async () => {
            const log = await readColdLog(persistence as unknown as PersistenceLike, header.id, abort.signal)
            // The handle's header is authoritative (fixed at open); the listed one was its probe.
            ;(cache as unknown as ProjectionCacheLike).coldSnapshot(log.header, log.inheritedEventCount, log.events)
            return true
          })
          if (admitted === undefined) {
            // Pressure does not fall within a pacing tick, so re-probing per session only delays the host's own work.
            paused = true
            break
          }
          folded++
        } catch (error: unknown) {
          if (isUnsupportedFormat(error)) {
            // Permanent and source-side: the per-session detail drops to
            // debug; the summary below is the pass's only above-debug word.
            refused++
            ctx.logger.debug(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          } else {
            ctx.logger.warn(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          }
        }
        await new Promise(resolve => setTimeout(resolve, YIELD_MS))
      }
      if (folded > 0) ctx.logger.info(`dsh-context: projection rows backfilled for ${folded} session(s)`)
      if (paused) {
        ctx.logger.info('dsh-context: projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)')
      }
      if (refused > 0) {
        ctx.logger.info(`dsh-context: projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`)
      }
    }
    launch = () => {
      void run().catch((error: unknown) => {
        if (!abort.signal.aborted) ctx.logger.warn(`dsh-context: projection backfill stopped early (${messageOf(error)})`)
      })
    }
    tryLaunch()
    return () => { abort.abort() }
  })

  return () => {
    for (const fiber of [routeFiber, runnerFiber]) {
      const handle = fiber as { dispose?: () => unknown } | undefined
      void handle?.dispose?.()
    }
  }
}
