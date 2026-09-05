// The timing fold (src/host/fold.ts): whole-session durations priced from the
// durable step lifecycle (step/start → assistant/attempt? → assistant/message →
// step/end) and the per-call tool durations (tool/call → tool/result via
// callId), plus the bounded per-name tally. No mocks: the real fold runs.
//
// Since dsh 0.1.3-alpha.1 there is no per-chunk `assistant/chunk` event — the
// first-token instant comes from the stream embedded in the settled
// `assistant/message`, or from an earlier failed `assistant/attempt` of the
// same step.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import {
  assistantAttempt,
  assistantMessage,
  rawChunk,
  run,
  stepEnd,
  stepStart,
  tokenAt,
  toolCall,
  toolResult,
} from './helpers/events'
import { assertPlainJson, assertStable, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

/** One full step lifecycle at explicit times: start, message (with its stream), end. */
function step(seq: number, startMs: number, lmMs: number, opts: { tokenMs?: number; usage?: Record<string, number> } = {}): TimelineEvent[] {
  return [
    { type: 'step/start', seq, time: startMs },
    assistantMessage(seq + 1, {
      time: startMs + lmMs,
      usage: opts.usage as never,
      ...(opts.tokenMs === undefined ? {} : { stream: tokenAt(startMs + opts.tokenMs) }),
    }),
    { type: 'step/end', seq: seq + 2, time: startMs + lmMs + 4000 },
  ]
}

describe('timing — step lifecycle', () => {
  test('a step prices its TTFT, generation, and wall time, then disarms the slot', () => {
    const { state } = driveTimeline(step(1, 10_000, 2_000, { tokenMs: 600 }))
    assert.deepEqual(state.timing, {
      wallMs: 6_000, ttftMs: 600, genMs: 1_400, calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
    })
    assert.equal(state.stepStart, undefined, 'step/end consumes the pending slot')
  })

  test('steps accumulate; the pending slot prices assistant/message and step/end of the SAME step', () => {
    const { state } = driveTimeline([...step(1, 0, 1_000, { tokenMs: 200 }), ...step(4, 10_000, 3_000, { tokenMs: 1_500 })])
    assert.equal(state.timing?.wallMs, 12_000)
    assert.equal(state.timing?.ttftMs, 1_700)
    assert.equal(state.timing?.genMs, 2_300)
    assert.equal(state.timing?.calls, 2)
  })

  test('an unpaired step/end is uninteresting (same state reference)', () => {
    const { state, def } = driveTimeline([])
    assertStable(state, stepEnd(1))
    assert.equal(def.apply(state, stepEnd(1)), state)
  })

  test('a step/end without a start leaves timing absent', () => {
    const { state } = driveTimeline([stepEnd(1)])
    assert.equal(state.timing, undefined)
  })

  test('assistant/message without an open step still counts the call, no model time', () => {
    const { state } = driveTimeline([assistantMessage(1, { stream: tokenAt(100) })])
    assert.equal(state.timing?.calls, 1)
    assert.equal(state.timing?.ttftMs, 0)
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.wallMs, 0)
  })

  test('a second step/start supersedes the pending slot', () => {
    // The first step's stamp dies with the slot: the second start opens a fresh
    // one, and the message that settles IT prices against that start.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantAttempt(2, tokenAt(500)),
      stepStart(3, { time: 10_000 }),
      assistantMessage(4, { time: 12_000, stream: tokenAt(11_000) }),
      stepEnd(5, { time: 13_000 }),
    ])
    assert.equal(state.timing?.ttftMs, 1_000)
    assert.equal(state.timing?.genMs, 1_000)
    assert.equal(state.timing?.wallMs, 3_000)
  })

  test('non-finite or negative durations degrade to zero', () => {
    const { state } = driveTimeline([
      { type: 'step/start', seq: 1, time: Number.NaN },
      assistantMessage(2, { time: 5_000, stream: tokenAt(5_000) }),
      { type: 'step/end', seq: 3, time: 6_000 },
    ])
    assert.equal(state.timing?.ttftMs, 0)
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.wallMs, 0)
    assert.equal(state.timing?.calls, 1)
  })

  test('timing-bearing states stay plain JSON — stamped slot included', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantAttempt(2, tokenAt(300)),
      assistantMessage(3, { time: 1_000 }),
      toolCall(4, { callId: 'c1', name: 'bash' }),
      toolResult(5, { callId: 'c1', content: text('ok') }),
      stepEnd(6, { time: 30_000 }),
    ])
    const copy = assertPlainJson(drive.state)
    assert.ok((copy.timing?.toolsMs ?? 0) > 0)
    // The intermediate stamped-slot state rode through too.
    const stamped = drive.states.find(s => s.stepStart?.firstToken !== undefined)
    assert.ok(stamped !== undefined)
    assertPlainJson(stamped)
  })
})

describe('timing — the first-token instant', () => {
  test('the settled message reads its OWN embedded stream — no slot stamp needed', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000, stream: tokenAt(600) }),
    ])
    assert.equal(drive.state.timing?.ttftMs, 600)
    assert.equal(drive.state.timing?.genMs, 1_400)
    assert.equal(
      drive.states.some(s => s.stepStart?.firstToken !== undefined), false,
      'the common path never stamps the slot',
    )
  })

  test('only the FIRST token of the stream counts', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 2_000,
        stream: [run('text-chunks', 600, ['x', 'y', 'z'], { dt: [100, 100] }), run('reasoning-chunks', 1_000, ['w'])],
      }),
    ])
    assert.equal(state.timing?.ttftMs, 600)
    assert.equal(state.timing?.genMs, 1_400)
  })

  test('a run skips its empty leading members and prices the first real token', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000, stream: [run('text-chunks', 300, ['', '', 'x'], { dt: [200, 200] })] }),
    ])
    assert.equal(state.timing?.ttftMs, 700, 'time0 + dt[0] + dt[1]')
    assert.equal(state.timing?.genMs, 1_300)
  })

  test("a failed attempt's token wins over the settled message's own stream", () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantAttempt(2, tokenAt(400)),
      assistantMessage(3, { time: 2_000, stream: tokenAt(1_500) }),
    ])
    assert.equal(state.timing?.ttftMs, 400, 'the earliest delivered token is the step wait')
    assert.equal(state.timing?.genMs, 1_600)
  })

  test('only the first attempt stamps; a later one is uninteresting', () => {
    const { state, def } = driveTimeline([stepStart(1, { time: 0 })])
    const stamped = def.apply(state, assistantAttempt(2, tokenAt(100)))
    assert.notEqual(stamped, state)
    assert.equal(stamped.stepStart?.firstToken, 100)
    assertStable(stamped, assistantAttempt(3, tokenAt(200)), def)
  })

  test('an attempt outside an open step, or with no token, is uninteresting', () => {
    const open = driveTimeline([])
    assertStable(open.state, assistantAttempt(1, tokenAt(100)))
    const armed = driveTimeline([stepStart(1, { time: 0 })])
    assertStable(armed.state, assistantAttempt(2, [rawChunk(400, { type: 'usage' })]), armed.def)
  })

  test('marking deltas: non-empty text, reasoning, and tool-call runs price', () => {
    // The raw `{type:'chunk'}` cases are the real shapes the run compaction
    // refuses to fold: a tool-call delta with an empty id or an empty name.
    for (const stream of [
      [run('text-chunks', 400, ['x'])],
      [run('reasoning-chunks', 400, ['…'])],
      [run('tool-call-chunks', 400, ['{'], { id: 'c1' })],
      [run('tool-call-chunks', 400, [''], { id: 'c1', name: 'bash' })],
      [rawChunk(400, { type: 'text-delta', index: 0, text: 'x' })],
      [rawChunk(400, { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{' })],
      [rawChunk(400, { type: 'tool-call-delta', index: 0, id: 'c1', name: '', argumentsDelta: '' })],
    ]) {
      const { state } = driveTimeline([
        stepStart(1, { time: 0 }),
        assistantMessage(2, { time: 900, stream }),
      ])
      assert.equal(state.timing?.ttftMs, 400, JSON.stringify(stream))
      assert.equal(state.timing?.genMs, 500, JSON.stringify(stream))
    }
  })

  test('a stream carrying no token leaves the call unattributed', () => {
    for (const stream of [
      undefined,
      null,
      'text-chunks',
      5,
      {},
      [],
      [null],
      ['text-chunks'],
      [{ type: 'text-chunks', time0: 400, index: 0, dt: [], texts: [''] }],
      [{ type: 'reasoning-chunks', time0: 400, index: 0, dt: [], texts: [7] }],
      [{ type: 'text-chunks', index: 0, dt: [], texts: ['x'] }],
      [{ type: 'text-chunks', time0: 400, index: 0, dt: [], texts: 'x' }],
      [{ type: 'tool-call-chunks', time0: 400, index: 0, dt: [], id: 'c1', args: [''] }],
      [{ type: 'unknown-run', time0: 400, index: 0, dt: [], texts: ['x'] }],
      [rawChunk(400, { type: 'usage' })],
      [rawChunk(400, { type: 'text-delta', index: 0, text: '' })],
      [rawChunk(400, { type: 'text-delta', index: 0, text: 7 })],
      [rawChunk(400, { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '' })],
      [rawChunk(400, { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: 3 })],
      [rawChunk(400, null)],
      [{ type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'x' } }],
    ]) {
      const { state } = driveTimeline([
        stepStart(1, { time: 0 }),
        assistantMessage(2, { time: 900, ...(stream === undefined ? {} : { stream }) }),
      ])
      assert.equal(state.timing?.ttftMs, 0, JSON.stringify(stream))
      assert.equal(state.timing?.genMs, 0, JSON.stringify(stream))
      assert.equal(state.timing?.calls, 1, JSON.stringify(stream))
    }
  })

  test('a run whose dt breaks mid-way prices only the members it could stamp', () => {
    // dt[0] is unreadable, so member 1 onward has no instant: member 0 is empty,
    // so nothing in this record can be a token.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 900, stream: [{ type: 'text-chunks', time0: 400, index: 0, dt: ['x'], texts: ['', 'y'] }] }),
    ])
    assert.equal(state.timing?.ttftMs, 0)
    assert.equal(state.timing?.calls, 1)
  })

  test('a run with no dt at all still prices its first member', () => {
    // `dt` is required alongside its members in the durable form; a record
    // missing it is malformed, and only the member time0 already stamps stays
    // readable.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 900, stream: [{ type: 'text-chunks', time0: 400, index: 0, texts: ['x', 'y'] }] }),
    ])
    assert.equal(state.timing?.ttftMs, 400)
    assert.equal(state.timing?.genMs, 500)
  })
})

describe('timing — tool call durations', () => {
  test('a paired result prices its duration and the per-name tally', () => {
    const { state } = driveTimeline([
      { type: 'tool/call', seq: 1, time: 1_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      toolResult(2, { callId: 'c1', content: text('ok'), time: 4_500 }),
    ])
    assert.deepEqual(state.timing, {
      wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 3_500, toolCalls: 1,
      tools: { bash: { calls: 1, ms: 3_500 } },
    })
  })

  test('repeated names accumulate; the block-id fallback prices too', () => {
    const call = (seq: number, callId: string, time: number): TimelineEvent => ({
      type: 'tool/call', seq, time, data: { callId, name: 'bash', arguments: '{}' },
    })
    const blockResult: TimelineEvent = {
      type: 'tool/result', seq: 5, time: 9_000,
      data: {
        callId: 'x',
        message: {
          source: { kind: 'tool', callId: 'x' },
          content: [{ type: 'tool-result', toolCallId: 'c2', content: text('ok') }],
        },
      },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([
      call(1, 'c1', 1_000),
      toolResult(2, { callId: 'c1', content: text('ok'), time: 3_000 }),
      call(4, 'c2', 5_000),
      blockResult,
    ])
    assert.equal(state.timing?.toolsMs, 2_000 + 4_000)
    assert.deepEqual(state.timing?.tools, { bash: { calls: 2, ms: 6_000 } })
  })

  test('an unpaired result carries no duration and no tally', () => {
    const { state } = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })])
    assert.equal(state.timing, undefined)
  })

  test('result before call (out-of-order log) prices nothing', () => {
    const { state } = driveTimeline([
      toolResult(1, { callId: 'c1', content: text('ok'), time: 2_000 }),
      toolCall(2, { callId: 'c1', name: 'bash' }),
    ])
    assert.equal(state.timing, undefined)
  })

  test('the per-name tally stays bounded: the smallest ms evicts past 16 names', () => {
    const events: TimelineEvent[] = []
    let seq = 1
    for (let i = 0; i < 17; i++) {
      // Tool 't0' is the cheapest (100ms); every later tool is costlier, so
      // the cap eviction must repeatedly drop 't0'… until it returns with a
      // heavier call — model a unique heavy tool per round instead.
      events.push({ type: 'tool/call', seq: seq++, time: i * 1_000, data: { callId: 'c' + i, name: 't' + i, arguments: '{}' } })
      events.push(toolResult(seq++, { callId: 'c' + i, content: text('ok'), time: i * 1_000 + (i === 0 ? 100 : 5_000) }))
    }
    // Feed the cheapest call LAST so the eviction path must drop it.
    const { state } = driveTimeline(events)
    assert.equal(Object.keys(state.timing?.tools ?? {}).length, 16)
    assert.equal(state.timing?.tools.t0, undefined, 'the cheapest tally left the ranking')
  })

  test('a new name past the cap evicts the current minimum, not itself', () => {
    const events: TimelineEvent[] = []
    let seq = 1
    // 16 established tools at 5s each.
    for (let i = 0; i < 16; i++) {
      events.push({ type: 'tool/call', seq: seq++, time: 0, data: { callId: 'c' + i, name: 't' + i, arguments: '{}' } })
      events.push(toolResult(seq++, { callId: 'c' + i, content: text('ok'), time: 5_000 }))
    }
    // One more: 6s, a new maximum — the eviction must drop one of the 5s rows.
    events.push({ type: 'tool/call', seq: seq++, time: 0, data: { callId: 'cx', name: 'tx', arguments: '{}' } })
    events.push(toolResult(seq++, { callId: 'cx', content: text('ok'), time: 6_000 }))
    const { state } = driveTimeline(events)
    const tools = state.timing?.tools ?? {}
    assert.equal(Object.keys(tools).length, 16)
    assert.equal(tools.tx?.ms, 6_000, 'the new name survived')
  })
})

describe('timing — served wire view', () => {
  test('buildTimelineView serves deep copies (no aliasing of persisted state)', () => {
    const drive = driveTimeline([...step(1, 0, 1_000, { tokenMs: 300 }),
      toolCall(5, { callId: 'c1', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') })])
    assert.ok(drive.state.timing !== undefined)
    assert.ok(drive.view.timing !== undefined)
    assert.notEqual(drive.view.timing, drive.state.timing)
    assert.notEqual(drive.view.timing.tools, drive.state.timing.tools)
    assert.notEqual(drive.view.timing.tools.bash, drive.state.timing.tools.bash)
    assert.deepEqual(drive.view.timing, drive.state.timing)
  })

  test('absent timing stays absent on the wire', () => {
    const { view } = driveTimeline([])
    assert.equal(view.timing, undefined)
  })

  test('the persisted-state schema accepts the timing shape (stamped slot included)', () => {
    const def = timelineDef({})
    const drive = driveTimeline([...step(1, 0, 1_000, { tokenMs: 300 }),
      toolCall(5, { callId: 'c1', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') }),
      stepEnd(7, { time: 30_000 })])
    // The 0.1.1+ contract validates persisted state through stateSchema.
    const c = def as unknown as { stateSchema: { parse(s: unknown): unknown } }
    for (const state of drive.states) c.stateSchema.parse(structuredClone(state)) // throws on drift
  })
})
