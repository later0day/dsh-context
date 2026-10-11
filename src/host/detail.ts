/**
 * The on-demand DETAIL route of the split `contextTimeline` generation.
 *
 * The projection's wire value is the slim head (fold.ts `buildTimelineHead`); the heavy
 * collections are served HERE instead — one targeted read per viewing client, only while its
 * Context tab or /context modal is open, instead of riding every session.list row and push frame
 * whole.
 *
 * The transport is Connection's exact Fetch-route registry (`ctx.connection.fetch.register`), the
 * same seam the harness's file-upload and media-reference routes mount through, under the
 * authenticated `/api` fence. A LIVE session's state comes straight off the registry's `stateOf`
 * (no second fold); a session only ever VIEWED cold is observed through `ctx.sessionQuery` and
 * its immutable log folded from init. Anything else resolves to a typed `null`.
 *
 * Load order is never assumed: the nested `ctx.inject` on connection + sessions arms the route
 * even for a service activating later; the returned gate is read at every serve, so the wire
 * generation flips with the route.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import { buildTimelineDetail } from './foldWire'

/** The plugin's detail route, under the authenticated `/api` fence. */
export const DETAIL_ROUTE = '/api/dsh-context/detail'

/** Read by the timeline unit's view at every serve. */
export interface DetailChannelGate {
  readonly live: boolean
}

/** The host `sessions` service, as far as the route consumes it (the strict-global-read idiom). */
interface SessionsHostFace {
  get?(id: string): unknown
}

/** The prepared-observation read that folds a session only ever viewed cold. */
interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

/** Serve the detail route whenever the connection and sessions services are both composed (see
 * the module header). Either service unloading withdraws the route and closes the gate. */
export function watchDetailChannel(ctx: Context, bounds: FoldBounds, coldReads: ColdReadGate = makeColdReadGate()): DetailChannelGate {
  const gate = { live: false }
  ctx.inject(['connection', 'sessions'], (c) => {
    const sessions = c.get('sessions') as SessionsHostFace | undefined
    // Bind at extraction: an unbound hand-off loses `this` on the real face.
    const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
    if (getSession === undefined) return
    const projections = ctx.sessionProjections

    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      try {
        const body: unknown = await request.json()
        sessionId = body !== null && typeof body === 'object'
          ? (body as { sessionId?: unknown }).sessionId
          : undefined
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      try {
        const session = getSession(sessionId)
        if (session !== undefined && session !== null) {
          // Live session: the registry's current fold state — no second fold, never mutated.
          const state = projections.stateOf(session as never, 'contextTimeline')
          if (state === undefined) return reply({ ok: true, value: null })
          return reply({ ok: true, value: buildTimelineDetail(state, bounds) })
        }
        // Cold session: observe it and fold the detail from its immutable log. The read runs
        // through the shared cold-read gate; a skip under heap pressure resolves to the same
        // typed null as a session nothing can observe.
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return reply({ ok: true, value: null })
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          const events = (observation as { events?: unknown } | null)?.events
          if (!Array.isArray(events)) return null
          let state = createTimelineState()
          try {
            for (const ev of events) state = applyTimeline(state, ev as never, bounds)
          } finally {
            const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
          return buildTimelineDetail(state, bounds)
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }

    // A hostile or rejecting registry leaves the route absent: the gate stays closed.
    if (!registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, DETAIL_ROUTE, handler, 'dsh-context: detail route')) return
    gate.live = true
    return () => {
      gate.live = false
    }
  })
  return gate
}
