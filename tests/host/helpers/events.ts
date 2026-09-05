// Durable session-event envelope builders for the fold specs. Shapes mirror
// the harness's durable vocabulary (`SessionEventMap` in @deepseek-ai/dsh-session,
// plus the dsh-compaction declaration-merged `compaction/*` family) — the same
// envelopes a real session log carries, minus fields the fold never reads.

import type { TimelineEvent } from '../../../src/host/fold'
import type { ContentBlock, MessageSource } from '../../../src/host/pricing'

let clock = 0

/** Monotonic timestamps, so folded records stay time-ordered without thinking. */
export function at(time?: number): number {
  clock += 1000
  return time ?? clock
}

export function header(seq: number, opts: {
  system?: unknown
  tools?: unknown[]
  model?: unknown
  provider?: unknown
  reason?: 'initial' | 'resume' | 'change'
  /** Override the whole config object (e.g. to omit model/provider). */
  config?: unknown
  time?: number
}): TimelineEvent {
  const h: Record<string, unknown> = { config: opts.config ?? { model: opts.model, provider: opts.provider } }
  if (opts.system !== undefined) h.system = opts.system
  if (opts.tools !== undefined) h.tools = opts.tools
  return { type: 'request/header', seq, time: at(opts.time), data: { header: h, reason: opts.reason ?? 'initial' } }
}

export function requestContext(seq: number, data?: Record<string, unknown>): TimelineEvent {
  return { type: 'request/context', seq, time: at(), ...(data === undefined ? {} : { data }) }
}

/** user/message: the durable payload IS the message (deriveEventMessage returns data). */
export function userMessage(seq: number, content: ContentBlock[], source?: MessageSource | null, opts: {
  time?: number
  surfaceOp?: TimelineEvent['surfaceOp']
} = {}): TimelineEvent {
  const data: Record<string, unknown> = { content }
  if (source !== undefined) data.source = source
  return { type: 'user/message', seq, time: at(opts.time), data, surfaceOp: opts.surfaceOp ?? 'append' }
}

export function toolCall(seq: number, opts: {
  callId?: unknown
  name?: unknown
  arguments?: string
  turn?: number
  step?: number
}): TimelineEvent {
  return { type: 'tool/call', seq, time: at(), data: { callId: opts.callId, name: opts.name, arguments: opts.arguments ?? '{}' } }
}

export function stepStart(seq: number, opts: { time?: number } = {}): TimelineEvent {
  return { type: 'step/start', seq, time: at(opts.time) }
}

/**
 * One run-compacted stream record: members are stamped from `time0`, each
 * later one `dt[i-1]` after its predecessor (the durable
 * `AssistantStreamRecord` run form embedded in settled Assistant events).
 */
export function run(
  type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks',
  time0: number,
  members: unknown[],
  opts: { dt?: number[]; index?: number; id?: string; name?: string } = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type,
    time0,
    index: opts.index ?? 0,
    dt: opts.dt ?? Array.from({ length: Math.max(0, members.length - 1) }, () => 0),
  }
  if (type === 'tool-call-chunks') {
    record.args = members
    record.id = opts.id ?? 'call-1'
    if (opts.name !== undefined) record.name = opts.name
  } else {
    record.texts = members
  }
  return record
}

/**
 * One `{type:'chunk', time, chunk}` record — the durable form for a lone chunk
 * the run compaction cannot fold (block boundaries, usage, finish, and
 * unnameable tool-call deltas).
 */
export function rawChunk(time: number, chunk: unknown): Record<string, unknown> {
  return { type: 'chunk', time, chunk }
}

/** A one-token text stream stamped at `time` — the common fixture. */
export function tokenAt(time: number, text = 'x'): unknown[] {
  return [run('text-chunks', time, [text])]
}

/**
 * assistant/attempt: a settled model attempt that committed no surface
 * message, carrying the stream it did deliver.
 */
export function assistantAttempt(seq: number, stream: unknown, opts: { time?: number } = {}): TimelineEvent {
  return { type: 'assistant/attempt', seq, time: at(opts.time), data: { stream } }
}

export function stepEnd(seq: number, opts: { time?: number } = {}): TimelineEvent {
  return { type: 'step/end', seq, time: at(opts.time) }
}

/** tool/result: the model-visible message rides data.message with the tool source. */
export function toolResult(seq: number, opts: {
  callId: string
  content: ContentBlock[]
  error?: boolean
  /** Drop the durable source (a legacy/foreign envelope). */
  noSource?: boolean
  /** Drop the envelope callId (source carries it). */
  noEnvelopeId?: boolean
  time?: number
}): TimelineEvent {
  const message: Record<string, unknown> = {
    content: [{ type: 'tool-result', toolCallId: opts.callId, content: opts.content }],
  }
  if (opts.noSource !== true) message.source = { kind: 'tool', callId: opts.callId }
  const data: Record<string, unknown> = { message }
  if (opts.noEnvelopeId !== true) data.callId = opts.callId
  if (opts.error === true) data.error = true
  return { type: 'tool/result', seq, time: at(opts.time), data, surfaceOp: 'append' }
}

export function assistantMessage(seq: number, opts: {
  turn?: number
  step?: number
  content?: ContentBlock[]
  /** Widened: hostile fixtures ride the same field (the fold re-proves every bucket). */
  usage?: Record<string, unknown>
  /** The step's embedded timed stream (widened for malformed-log fixtures). */
  stream?: unknown
  time?: number
  surfaceOp?: TimelineEvent['surfaceOp']
}): TimelineEvent {
  const data: Record<string, unknown> = { message: { content: opts.content ?? [{ type: 'text', text: 'reply' }] } }
  if (opts.turn !== undefined) data.turn = opts.turn
  if (opts.step !== undefined) data.step = opts.step
  if (opts.usage !== undefined) data.usage = opts.usage
  if (opts.stream !== undefined) data.stream = opts.stream
  return { type: 'assistant/message', seq, time: at(opts.time), data, surfaceOp: opts.surfaceOp ?? 'append' }
}

export function compaction(seq: number, kind: 'summary' | 'prune', data?: Record<string, unknown>): TimelineEvent {
  return { type: `compaction/${kind}`, seq, time: at(), ...(data === undefined ? {} : { data }) }
}

export function planMode(seq: number, data?: Record<string, unknown>): TimelineEvent {
  return { type: 'plan/mode', seq, time: at(), ...(data === undefined ? {} : { data }) }
}

/** An event the fold does not care about (todo, hooks, …). */
export function foreign(seq: number, type = 'todo/write'): TimelineEvent {
  return { type, seq, time: at(), data: {} }
}
