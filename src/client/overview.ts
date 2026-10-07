/**
 * The Context Dashboard's data layer: everything the panel renders is derived
 * here, off the root-scope `useSessions` standard prop. Each session-list
 * row carries the host-cached projection values — this plugin's
 * `contextTimeline` (composition, counts, cost) and `contextActivity` (the
 * daily ledger) — so the overview joins every session's insight WITHOUT
 * opening a single session log.
 *
 * The row IS the team: subagent-origin sessions never list (the workspace
 * browser's own exclusion), so every row folds its WHOLE descendant subtree
 * into itself — the card's billed tokens and cost, the KPI band, the usage
 * chart, and the heatmap all read the family scope, each member contributing
 * its own composition and daily ledger, nothing counted twice.
 *
 * The list is harness data (untrusted at the boundary): the snapshot is
 * re-proved field by field, every projection value passes its services.ts
 * sanitizer, and each row's derivation is isolated — one hostile row drops
 * to a metadata-only card or out of the list, never an error card. All
 * functions here are pure (the hook-level read lives in
 * {@link sessionsSnapshotOf}), so the panel's rendering stays a trivial map.
 */

import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { billedParts } from './categories'
import { cacheHitPercent } from './format'
import { estimateSessionCost, mergeCostUsage } from './cost'
import type { CostCurrency, ModelBook } from './cost'
import { agentRowOf } from './agentTree'
import { activityOf, asRecord, timelineOf, type ClientCtx, type SessionsFace } from './services'
import type { ContextActivity, ContextTimeline, SessionCostUsage, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

/** One session-list row joined with its (sanitized) projection values. */
export interface OverviewRow {
  id: string
  /** Display title: durable title, project basename, then the raw id (the list's own ladder). */
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  /** The session the conversation currently shows — its card carries the "current" mark. */
  current: boolean
  /** The sanitized timeline head, or null when the host folded nothing for this session yet. */
  timeline: ContextTimeline | null
  /**
   * The TEAM's merged daily ledger (this session's own plus every descendant
   * subagent's, day by day), or null when no member carries one. Subagent-origin
   * sessions never list (the workspace browser's exclusion, see rowsOfSnapshot),
   * so each family folds into exactly one row and nothing counts twice.
   */
  activity: ContextActivity | null
  /** Every subtree member's sanitized head, self first, ALL levels — the parts split proportions each member's OWN composition. */
  family: (ContextTimeline | null)[]
  /** The subtree's merged billed usage — the card stat, KPI band, and token sort's family figure (null: nothing billed anywhere). */
  familyCost: SessionCostUsage | null
}

/**
 * The `useSessions` standard prop read, hook-safe and hostility-proof: the
 * seat must be a function (absent = a harness without the sessions service —
 * the panel renders its unavailable note), and a throwing seat/snapshot
 * reads as null. Called unconditionally at the top of the panel component
 * (the seat is a real hook; the identity selector keeps the raw snapshot so
 * the pure {@link rowsOfSnapshot} derivation can ride useMemo).
 */
export function sessionsSnapshotOf(props: { useSessions?: unknown }): unknown {
  const useSessions = props.useSessions
  if (typeof useSessions !== 'function') return null
  try {
    return (useSessions as <T>(selector: (snapshot: unknown) => T) => T)(snapshot => snapshot)
  } catch {
    return null
  }
}

/**
 * The `useWorkspaces` standard prop read — same guarded-hook contract as
 * {@link sessionsSnapshotOf}. The overview joins its session → workspace
 * grouping off this snapshot for the cards' breadcrumb row.
 */
export function workspacesSnapshotOf(props: { useWorkspaces?: unknown }): unknown {
  const useWorkspaces = props.useWorkspaces
  if (typeof useWorkspaces !== 'function') return null
  try {
    return (useWorkspaces as <T>(selector: (snapshot: unknown) => T) => T)(snapshot => snapshot)
  } catch {
    return null
  }
}

/**
 * Session id → workspace title, projected off the workspaces snapshot (the
 * registry's own membership lists, not path guessing). Null when the
 * snapshot is unusable — the breadcrumb then shows the project name alone.
 * A session no workspace claims simply has no crumb group (the workspace
 * browser's "Ungrouped" bucket is a container, not a name to print).
 */
export function sessionGroupsOf(snapshot: unknown): Record<string, string> | null {
  const state = asRecord(snapshot)
  if (state === null || !Array.isArray(state.items)) return null
  const groups: Record<string, string> = {}
  // Widened honestly: a Record index read can miss at runtime.
  const claimed: Record<string, string | undefined> = groups
  for (const item of state.items) {
    const workspace = asRecord(item)
    if (workspace === null) continue
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
    if (title === undefined || !Array.isArray(workspace.sessionIds)) continue
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string' && claimed[id] === undefined) groups[id] = title
    }
  }
  return groups
}

/** The card's project name: the workspace browser's own basename derivation (both separators). */
export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

/** The group-filter chip key of the ungrouped bucket (a title can never collide — the registry dedupes names). */
export const UNGROUPED_KEY = '__ungrouped__'

/** One group chip: its filter key and the rows currently in it. */
export interface GroupCount {
  key: string
  count: number
}

/**
 * The group chips' counts, in workspace-registry order with the ungrouped
 * bucket last, computed over the ALREADY scoped rows (range/day/query
 * applied) so the chips mirror the scope the user set. Groups with no row
 * in scope drop out (a chip that can yield no card is noise); the panel
 * keeps a vanished selection's chip alive itself.
 */
export function groupCountsOf(rows: readonly OverviewRow[], snapshot: unknown): GroupCount[] {
  const state = asRecord(snapshot)
  if (state === null || !Array.isArray(state.items)) return []
  // Session id → claiming workspace title (first claim wins, same as the crumbs).
  const claimed = new Map<string, string>()
  const titles: string[] = []
  for (const item of state.items) {
    const workspace = asRecord(item)
    if (workspace === null) continue
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
    if (title === undefined || !Array.isArray(workspace.sessionIds)) continue
    titles.push(title)
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string' && !claimed.has(id)) claimed.set(id, title)
    }
  }
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const row of rows) {
    const title = claimed.get(row.id)
    if (title === undefined) ungrouped++
    else counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const groups: GroupCount[] = []
  for (const title of titles) {
    const count = counts.get(title) ?? 0
    if (count > 0) groups.push({ key: title, count })
  }
  if (ungrouped > 0) groups.push({ key: UNGROUPED_KEY, count: ungrouped })
  return groups
}

/** Whether one row belongs to the group-filter selection (the ungrouped bucket matches claimless rows). */
export function inGroup(row: OverviewRow, group: string, groups: Record<string, string> | null): boolean {
  // Widened honestly: a Record index read can miss at runtime.
  const byId: Record<string, string | undefined> = groups ?? {}
  const title = byId[row.id]
  return group === UNGROUPED_KEY ? title === undefined : title === group
}

/**
 * The workspace snapshot's archived-session set, re-proved: an absent seat,
 * a hostile shape, or a throwing accessor archives nothing — filtering fail
 * open to the unfiltered list, never fail closed to an empty one.
 */
function archivedSetOf(workspaces: unknown): Set<string> {
  try {
    const value = asRecord(workspaces)?.archivedSessionIds
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/**
 * Join the raw session-list snapshot into render-ready rows, or null when
 * the snapshot is unusable (absent service, hostile root — the panel's
 * unavailable note, distinct from a real empty list). Blank rows (a
 * never-engaged session's placeholder) are not insight material and drop
 * out; archived rows drop too (the raw list carries every session — the
 * workspace browser hides its archive set, and the overview must not
 * surface ghosts its sibling surface hides); every other row derives in
 * isolation, so one throwing row costs just itself.
 */
export function rowsOfSnapshot(snapshot: unknown, workspaces?: unknown): OverviewRow[] | null {
  const state = asRecord(snapshot)
  if (state === null) return null
  if (!Array.isArray(state.ids)) return null
  const ids: string[] = state.ids.filter((id): id is string => typeof id === 'string')
  const archived = archivedSetOf(workspaces)
  const byId = asRecord(state.byId) ?? {}
  const current = typeof state.current === 'string' ? state.current : undefined
  const rows: OverviewRow[] = []
  for (const id of ids) {
    if (archived.has(id)) continue
    try {
      const row = asRecord(byId[id])
      if (row === null) continue
      if (row.blank === true) continue
      // Subagent-origin sessions are the workspace browser's own exclusion
      // (its tree predicate): they surface under their parent's catalog, and
      // a plain open() cannot address them (the host demands the durable
      // parent address) — so the overview lists main-line sessions only.
      if (row.origin === 'subagent') continue
      const displayTitle = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : undefined
      const title = typeof row.title === 'string' && row.title !== '' ? row.title : undefined
      const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined
      const values = asRecord(row.projectionValues)
      rows.push({
        id,
        title: displayTitle ?? title ?? id,
        ...(cwd !== undefined ? { cwd } : {}),
        updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        running: row.running === true,
        current: id === current,
        timeline: timelineOf(values?.contextTimeline),
        activity: activityOf(values?.contextActivity),
        family: [],
        familyCost: null,
      })
    } catch {
      // A hostile row (throwing accessor) drops whole; the list keeps working.
    }
  }
  // The family fold: every listed row owns its WHOLE subagent subtree (all
  // levels — the walk mirrors the Context tab's cost fold, agentTree
  // subagentCostFoldOf: childrenOf off non-blank rows' parentId, BFS with a
  // seen-set so a lineage cycle cannot loop). Each member's own sanitized
  // timeline and ledger join the row's family; the row's own `activity` then
  // becomes the team's merged ledger.
  const childrenOf = new Map<string, string[]>()
  for (const id of Object.keys(byId)) {
    // The row loop's own isolation, mirrored: a hostile (throwing) row drops
    // out of the lineage walk the same way it dropped out of the list.
    try {
      const row = agentRowOf(byId[id])
      if (row === null || row.blank || row.parentId === undefined) continue
      const list = childrenOf.get(row.parentId) ?? []
      list.push(id)
      childrenOf.set(row.parentId, list)
    } catch { /* the hostile row links nobody */ }
  }
  for (const row of rows) {
    const timelines: (ContextTimeline | null)[] = [row.timeline]
    const activities: (ContextActivity | null)[] = [row.activity]
    const seen = new Set<string>([row.id])
    const queue = [row.id]
    for (let i = 0; i < queue.length; i++) {
      for (const kid of childrenOf.get(queue[i]) ?? []) {
        if (seen.has(kid)) continue
        seen.add(kid)
        const values = asRecord(asRecord(byId[kid])?.projectionValues)
        timelines.push(timelineOf(values?.contextTimeline))
        activities.push(activityOf(values?.contextActivity))
        queue.push(kid)
      }
    }
    row.family = timelines
    row.familyCost = mergeCostUsage(...timelines.map(t => t?.cost))
    row.activity = mergeActivity(activities)
  }
  return rows
}

/**
 * Merge several sessions' daily ledgers into one family's: per day the tokens
 * and requests sum and the pricing records merge (each member's own entry,
 * same day — the fee prices off the same book downstream either way). Null
 * when no member carries a ledger, matching a lone session's day-less state.
 */
function mergeActivity(members: (ContextActivity | null)[]): ContextActivity | null {
  const days: ContextActivity['days'] = {}
  // Widened honestly: a Record index read can miss at runtime.
  const byKey: Record<string, ContextActivity['days'][string] | undefined> = days
  let any = false
  for (const activity of members) {
    if (activity === null) continue
    any = true
    for (const key of Object.keys(activity.days)) {
      const entry = activity.days[key]
      const prev = byKey[key]
      if (prev === undefined) {
        days[key] = { tokens: entry.tokens, requests: entry.requests, ...(entry.cost !== undefined ? { cost: entry.cost } : {}) }
      } else {
        prev.tokens += entry.tokens
        prev.requests += entry.requests
        if (entry.cost !== undefined) {
          /* v8 ignore next 1 -- a merge with a defined input never comes back empty. */
          prev.cost = mergeCostUsage(prev.cost, entry.cost) ?? entry.cost
        }
      }
    }
  }
  return any ? { days } : null
}

// ---- range / filter / sort -------------------------------------------------

export type OverviewRange = '24h' | '7d' | '30d' | 'all'

/** The range window's start instant (epoch ms), or null for "all". */
export function rangeStartOf(range: OverviewRange, now: number): number | null {
  if (range === '24h') return now - 86_400_000
  if (range === '7d') return now - 7 * 86_400_000
  if (range === '30d') return now - 30 * 86_400_000
  return null
}

export type OverviewSort = 'recent' | 'tokens' | 'context'

/**
 * The team card's cumulative billed tokens (the subtree's merged cost
 * buckets' sum), or null when nothing was billed anywhere — the sort and the
 * card stat share this one figure.
 */
export function billedOf(row: OverviewRow): number | null {
  const totals = usageTotalsOf(row.familyCost)
  return totals?.total ?? null
}

/** The session's turn tally: the split head's precomputed count, else the retained records' count. */
export function turnsOf(timeline: ContextTimeline | null): number {
  if (timeline === null) return 0
  return timeline.counts?.turns ?? timeline.requests.length
}

/**
 * The session's first active day (the ledger's earliest key) — the card's
 * creation-date line. The harness's client-facing list rows carry no
 * per-session creation time, so the first billed day stands in; undefined
 * when the ledger is absent (an older host, or no model requests yet).
 */
export function createdDayOf(activity: ContextActivity | null): string | undefined {
  const days = activity?.days
  if (days === undefined) return undefined
  let first: string | undefined
  for (const key of Object.keys(days)) {
    if (first === undefined || key < first) first = key
  }
  return first
}

/**
 * The panel's row pipeline: range (by last-activity), then the heatmap's
 * picked day (sessions contributing to that day's merged ledger), then the
 * search box (title, directory, or last-message substring). Each stage keeps
 * the rows it cannot prove out of the result — never an exception.
 */
export function filterRows(
  rows: readonly OverviewRow[],
  opts: { range: OverviewRange; day: string | null; query: string },
  now: number,
): OverviewRow[] {
  const start = rangeStartOf(opts.range, now)
  const query = opts.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (start !== null && row.updatedAt < start) return false
    if (opts.day !== null) {
      const entry = row.activity?.days[opts.day]
      if (entry === undefined || (entry.tokens <= 0 && entry.requests <= 0)) return false
    }
    if (query !== '') {
      const inTitle = row.title.toLowerCase().includes(query)
      const inCwd = row.cwd !== undefined && row.cwd.toLowerCase().includes(query)
      const lastUser = row.timeline?.lastUser
      const inLastUser = typeof lastUser === 'string' && lastUser.toLowerCase().includes(query)
      if (!inTitle && !inCwd && !inLastUser) return false
    }
    return true
  })
}

/** Order the filtered rows; the input array is never mutated. */
export function sortRows(rows: readonly OverviewRow[], sort: OverviewSort): OverviewRow[] {
  const copy = [...rows]
  if (sort === 'tokens') copy.sort((a, b) => (billedOf(b) ?? -1) - (billedOf(a) ?? -1))
  else if (sort === 'context') copy.sort((a, b) => (b.timeline?.current.total ?? -1) - (a.timeline?.current.total ?? -1))
  else copy.sort((a, b) => b.updatedAt - a.updatedAt)
  return copy
}

/** The session grid renders this many cards per page. */
export const OVERVIEW_PAGE_SIZE = 12

/**
 * The paged window over the sorted rows: the requested page clamped into
 * the live range, so a list that shrank between renders (a refresh, a
 * narrowed filter) keeps the view valid instead of showing a blank page.
 */
export function pageOf<T>(rows: readonly T[], page: number): { items: T[]; index: number; count: number } {
  const count = Math.max(1, Math.ceil(rows.length / OVERVIEW_PAGE_SIZE))
  const index = Math.min(Math.max(0, page), count - 1)
  return { items: rows.slice(index * OVERVIEW_PAGE_SIZE, (index + 1) * OVERVIEW_PAGE_SIZE), index, count }
}

// ---- aggregations ----------------------------------------------------------

/** The merged billed-bucket totals behind the KPI band and the cost estimate. */
export interface UsageTotals {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** input + cacheRead + cacheWrite + output — the whole billed volume. */
  total: number
}

/**
 * Sum one cost usage's buckets (already sanitized per bucket by the
 * timeline boundary). Null when no side carried a bucket record, so the
 * caller's cells keep their dash instead of a fabricated zero.
 */
export function usageTotalsOf(usage: SessionCostUsage | null | undefined): UsageTotals | null {
  if (usage === null || usage === undefined) return null
  const totals: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = usage[provider]
    for (const model of Object.keys(models)) {
      const periods = models[model]
      for (const period of ['peak', 'off'] as const) {
        const bucket = periods[period]
        if (bucket === undefined) continue
        totals.input += bucket.uncached
        totals.cacheRead += bucket.cacheRead
        totals.cacheWrite += bucket.cacheWrite
        totals.output += bucket.output
        any = true
      }
    }
  }
  if (!any) return null
  totals.total = totals.input + totals.cacheRead + totals.cacheWrite + totals.output
  return totals
}

/**
 * The range's summed timing totals — the aggregate Timing Stats card's
 * source, folded from the rows' host-folded whole-session totals exactly as
 * the KPI band folds the scalar figures. Null when no row carries timing.
 * The additive-optional fields (the decode split, the throughput seat) sum
 * their carriers only: a row cached before a field existed contributes
 * nothing to it, and a field no row carries stays absent — the card keeps
 * its un-split shape / no-chip fallback instead of materialized zeros.
 */
export function timingSumOf(rows: readonly OverviewRow[]): TimingTotals | null {
  let out: TimingTotals | null = null
  for (const row of rows) {
    const t = row.timeline?.timing
    if (t === undefined) continue
    if (out === null) {
      out = { ...t, tools: { ...t.tools } }
      continue
    }
    out.wallMs += t.wallMs
    out.ttftMs += t.ttftMs
    out.genMs += t.genMs
    out.calls += t.calls
    out.toolsMs += t.toolsMs
    out.toolCalls += t.toolCalls
    addOptionalOf(out, t, 'reasoningMs')
    addOptionalOf(out, t, 'reasoningBlocks')
    addOptionalOf(out, t, 'textMs')
    addOptionalOf(out, t, 'textBlocks')
    addOptionalOf(out, t, 'toolArgMs')
    addOptionalOf(out, t, 'toolArgBlocks')
    addOptionalOf(out, t, 'speedTokens')
    addOptionalOf(out, t, 'speedMs')
    for (const name of Object.keys(t.tools)) {
      const tool = t.tools[name]
      // Widened honestly: a Record index read can miss at runtime.
      const outTools: Record<string, ToolTimingTotals | undefined> = out.tools
      const prev = outTools[name]
      out.tools[name] = prev === undefined ? { ...tool } : { calls: prev.calls + tool.calls, ms: prev.ms + tool.ms }
    }
  }
  return out
}

/** One additive-optional timing field's in-place merge: absent on both sides stays absent (never a materialized undefined). */
function addOptionalOf(target: TimingTotals, source: TimingTotals, key: OptionalTimingKey): void {
  const a = target[key]
  const b = source[key]
  if (a !== undefined || b !== undefined) target[key] = (a ?? 0) + (b ?? 0)
}

type OptionalTimingKey = 'reasoningMs' | 'reasoningBlocks' | 'textMs' | 'textBlocks'
  | 'toolArgMs' | 'toolArgBlocks' | 'speedTokens' | 'speedMs'

/**
 * One aggregate slice of the Token Stats card: a composition category (or
 * `output`) with its summed billed estimate.
 */
export interface TokenPartTotal {
  key: string
  color: string
  value: number
}

/**
 * The range's billed tokens split by WHAT they are — the Context tab's Token
 * card categorization, folded across the rows' FAMILIES: every subtree
 * member's `billedParts` estimate (its OWN composition ratios proportioning
 * its own provider-reported prompt total, output exact) sums by category,
 * and every member's parts total its own billed figure, so the aggregate's
 * total stays the exact merged billed volume while the split inherits the
 * per-session card's `≈` estimate convention. Null when nothing billed
 * anywhere. A non-finite part estimate (a hostile fast-path composition)
 * drops whole instead of poisoning the sums.
 */
export function tokenPartsOf(rows: readonly OverviewRow[]): { parts: TokenPartTotal[]; total: number } | null {
  const sums = new Map<string, TokenPartTotal>()
  let total = 0
  let any = false
  for (const row of rows) {
    for (const member of row.family) {
      if (member === null) continue
      const totals = usageTotalsOf(member.cost)
      if (totals === null) continue
      any = true
      const usage: TokenUsage = {
        uncachedInputTokens: totals.input,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheWrite,
        outputTokens: totals.output,
      }
      for (const part of billedParts(member.current, null, usage)) {
        if (!Number.isFinite(part.value) || part.value <= 0) continue
        total += part.value
        // Widened honestly: a Map get can miss at runtime.
        const sumsGet: Map<string, TokenPartTotal | undefined> = sums
        const prev = sumsGet.get(part.key)
        sums.set(part.key, prev === undefined
          ? { key: part.key, color: part.color, value: part.value }
          : { ...prev, value: prev.value + part.value })
      }
    }
  }
  if (!any) return null
  return { parts: [...sums.values()], total }
}

/** The KPI band's figures, priced from the models.dev book (null cost until the book lands). */
export interface OverviewKpis {
  /** Sessions in the current range filter. */
  sessions: number
  /** Sessions in the whole list (the range cell's "of N total" sub-line). */
  listed: number
  /** Cumulative billed tokens across the range's sessions. */
  tokens: number
  /** Their turn tally. */
  turns: number
  /** Estimated spend in the display currency (null: nothing priced). */
  cost: number | null
  /** Sessions whose spend the book could price (the cost cell's sub-line). */
  costSessions: number
  /** Cache-hit share of billed input, truncated (null: nothing billed). */
  cacheHit: string | null
  /** Sessions whose usage feeds the cache-hit rate (the cache-hit cell's sub-line). */
  usageSessions: number
  /** Their completed tool calls. */
  toolCalls: number
  /** Their summed tool-run time (the tool-calls cell's sub-line). */
  toolsMs: number
  /** Their completed model calls. */
  calls: number
  /** Their summed wall time (the sessions' active time). */
  wallMs: number
  /** The range's billed tokens split by composition category (null: nothing billed) — the Token Stats card's slices. */
  tokenParts: { parts: TokenPartTotal[]; total: number } | null
  /** The range's summed timing totals (null: no timed session) — the Timing Stats card's source. */
  timing: TimingTotals | null
}

export function kpisOf(
  rows: readonly OverviewRow[],
  listed: number,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): OverviewKpis {
  // The KPI band's billed volume and spend ride the same family scope as the
  // cards and the chart: each row's subtree-merged usage.
  const usage = mergeCostUsage(...rows.map(row => row.familyCost))
  const totals = usageTotalsOf(usage)
  let turns = 0
  let toolCalls = 0
  let toolsMs = 0
  let calls = 0
  let wallMs = 0
  let costSessions = 0
  let usageSessions = 0
  for (const row of rows) {
    // Each qualifying sub-line counts the sessions its own figure covers: a
    // session with usage but no book rates feeds the cache-hit rate while
    // pricing to nothing.
    if (estimateSessionCost(row.familyCost, book, currency) !== null) costSessions++
    if (usageTotalsOf(row.familyCost) !== null) usageSessions++
    turns += turnsOf(row.timeline)
    const timing = row.timeline?.timing
    toolCalls += timing?.toolCalls ?? 0
    toolsMs += timing?.toolsMs ?? 0
    calls += timing?.calls ?? 0
    wallMs += timing?.wallMs ?? 0
  }
  return {
    sessions: rows.length,
    listed,
    tokens: totals?.total ?? 0,
    turns,
    cost: estimateSessionCost(usage, book, currency),
    costSessions,
    cacheHit: totals === null ? null : cacheHitPercent(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite),
    usageSessions,
    toolCalls,
    toolsMs,
    calls,
    wallMs,
    tokenParts: tokenPartsOf(rows),
    timing: timingSumOf(rows),
  }
}

/** One merged day of the daily ledgers: billed tokens, model requests, the sessions active that day, and the day's priced fee. */
export interface DayTotals {
  tokens: number
  requests: number
  sessions: number
  /**
   * The day's estimated spend in the display currency (null: nothing priced —
   * no pricing record folded, no book yet, or no model the book prices).
   */
  cost: number | null
}

/**
 * Merge every row's daily ledger into one — the heatmap's and the usage
 * chart's data (each row's ledger is already its family's merge, see
 * rowsOfSnapshot). A row counts toward a day only when its family entry
 * carries activity, mirroring the day filter's predicate, so the cell's
 * tooltip previews the click; a zeroed entry is skipped whole. Each day's
 * pricing records merge into one SessionCostUsage and price off the SAME
 * book/estimator the KPI band's cost cell rides (null fee on anything
 * unpriced). The merged record stays small even over long histories.
 */
export function aggregateDays(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): Record<string, DayTotals> {
  // The walk merges into a richer record (each day's fee raw material rides
  // along), then every merged day prices once — no second lookup pass.
  const merged: Record<string, { tokens: number; requests: number; sessions: number; fees: SessionCostUsage[] }> = {}
  const byKey: Record<string, { tokens: number; requests: number; sessions: number; fees: SessionCostUsage[] } | undefined> = merged
  for (const row of rows) {
    if (row.activity === null) continue
    for (const key of Object.keys(row.activity.days)) {
      const entry = row.activity.days[key]
      if (entry.tokens <= 0 && entry.requests <= 0) continue
      const prev = byKey[key]
      if (prev === undefined) {
        merged[key] = {
          tokens: entry.tokens,
          requests: entry.requests,
          sessions: 1,
          fees: entry.cost !== undefined ? [entry.cost] : [],
        }
      } else {
        prev.tokens += entry.tokens
        prev.requests += entry.requests
        prev.sessions++
        if (entry.cost !== undefined) prev.fees.push(entry.cost)
      }
    }
  }
  const days: Record<string, DayTotals> = {}
  for (const [key, day] of Object.entries(merged)) {
    // No fee records merge to null (nothing priced); records that merge but
    // match no book price null the same way.
    days[key] = {
      tokens: day.tokens,
      requests: day.requests,
      sessions: day.sessions,
      cost: estimateSessionCost(mergeCostUsage(...day.fees), book, currency),
    }
  }
  return days
}

// ---- presentation helpers --------------------------------------------------

/**
 * Re-pull the session-list baseline so host-side projection backfills
 * (host/backfill.ts) reach a long-connected browser. Fire-and-forget: the
 * verb is re-proved and every failure swallows — the panel renders off the
 * rows it already has either way.
 */
export function refreshSessions(ctx: ClientCtx): void {
  try {
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    if (sessions === undefined || typeof sessions.refresh !== 'function') return
    // Promise.resolve absorbs a non-promise return; rejections swallow.
    void Promise.resolve(sessions.refresh()).catch(() => { /* a failed re-pull keeps the stale rows */ })
  } catch { /* hostile service — no refresh */ }
}

// The plugin's warm-up trigger route (host/backfill.ts) — re-declared here:
// the client bundle inlines every import, and the host module must never
// reach it. Same-origin POST under the harness's authenticated `/api` fence.
const BACKFILL_ROUTE = '/api/dsh-context/backfill'

/**
 * Summon the host's projection warm-up (host/backfill.ts): the dashboard is
 * the rows' only reader, so the host defers the corpus-wide cold reads until
 * this surface first opens (one pass per host process — later opens no-op
 * server-side, and the host answers at once). Fire-and-forget: an older host
 * without the route, or a transport hiccup, just leaves the panel on the
 * rows it already has.
 */
export function requestActivityBackfill(): void {
  try {
    void fetch(BACKFILL_ROUTE, { method: 'POST' }).catch(() => { /* the rows arrive on a later open */ })
  } catch { /* hostile transport — the panel keeps its rows */ }
}

/**
 * The row's relative-activity label ("3m ago"), unit-stepped: under a
 * minute reads "just now", then minutes, hours, days. A future or invalid
 * timestamp reads as "just now" (clock skew is not an error worth a dash).
 */
export function relativeTime(t: (key: string, params?: Record<string, string | number>) => string, updatedAt: number, now: number): string {
  const diff = now - updatedAt
  if (!Number.isFinite(diff) || diff < 60_000) return t('ov.time.now')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('ov.time.m', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('ov.time.h', { n: hours })
  return t('ov.time.d', { n: Math.floor(hours / 24) })
}
