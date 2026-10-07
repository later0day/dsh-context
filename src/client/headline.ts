/**
 * Provider-anchored headline derivation, shared by the Context tab and the
 * /context popup: the best-known occupancy of the next request, the route
 * capacity it scales against, and the composition parts anchored to that
 * total (heuristic ratios, provider-anchored sum).
 *
 * Two official token-meter projections feed it, the same keys the chat's
 * composer ring reads: `contextPressure` supplies the anchored total (the
 * ring's percentage), and `contextBreakdown` supplies the composition
 * counts (the ring panel's system/tools/messages `~` rows) so the legend
 * figures stay identical to the panel's by construction. Either key absent
 * (older harness, meter not composed) degrades to the fold's own sums —
 * the same fixed estimator.
 *
 * The percent is the kernel's own reading (`occupancyPercent`, below) at one
 * decimal instead of the ring's integer — same numerator, denominator, and
 * clamp, so the two surfaces can never disagree on the value.
 */

import type { ContextBreakdown, ContextPressure, ContextTimeline } from '../shared/types'
import { anchoredParts, officialParts, type PartsPart } from './categories'

export interface Headline {
  /** Best-known occupancy of the next request (projected ?? sampled ?? derived ?? heuristic total). */
  tokens: number
  window?: number
  /** tokens / window on the kernel's occupancy grid (one decimal), clamped to 100; null without a window. */
  pct: number | null
  /**
   * Composition parts: `value` is the provider-anchored bar width (the
   * ring's fill), `raw` the official heuristic count (the ring panel's
   * rows) shown by the legend and tooltips.
   */
  parts: PartsPart[]
}

/**
 * Occupancy percent of one reading — the kernel's own composer-ring
 * derivation (`@deepseek-ai/dsh-client-ui-conversation`'s `contextOccupancy`:
 * `Math.min(100, Math.round(used / window * 100))`, `used` =
 * `projectedTokens ?? pressureTokens`) on a 0.1 grid instead of an integer
 * one. Same numerator, denominator, and clamp, so every plugin surface
 * prints the value the harness itself computes and only the precision of the
 * printed reading is the plugin's. Callers prove `window > 0`.
 */
export function occupancyPercent(tokens: number, window: number): number {
  return Math.min(100, Math.round(tokens / window * 1000) / 10)
}

export function headlineOf(
  data: ContextTimeline,
  pressure: ContextPressure | null = null,
  breakdown: ContextBreakdown | null = null,
): Headline {
  const current = data.current
  // The official projection's whole value is the newest usage sample carried
  // forward by the heuristic surface movement since it was taken — the same
  // formula the chat ring displays. Fields are last-wins; absent until a
  // provider reports usage.
  const projected = pressure !== null && typeof pressure.projectedTokens === 'number'
    ? pressure.projectedTokens
    : undefined
  // The kernel's own fallback order (`contextOccupancy`): the bare provider
  // sample. A real fold stamps `pressureTokens` and the surface sample it was
  // taken at together, so `projectedTokens` always rides along (only a foreign
  // or hand-edited cache row can drop it); keeping the order means even that
  // value reads the kernel's way.
  const sampled = pressure !== null && typeof pressure.pressureTokens === 'number'
    ? pressure.pressureTokens
    : undefined
  // Fallback anchor: the newest request's provider prompt plus the heuristic
  // surface movement since it was logged (same shape as the projection, one
  // request behind). The split-generation wire head carries that record's
  // billing summary as `last` (the request records ride the detail channel);
  // the inline generation reads its newest record directly.
  const last = data.last
  const requests = data.requests
  const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
  const anchor = last !== undefined ? last : lastReq
  const derived = anchor !== null && typeof anchor.prompt === 'number'
    ? anchor.prompt + (current.total - anchor.total)
    : undefined
  const occupancyTokens = projected ?? sampled ?? derived ?? null
  const window = pressure !== null && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : data.contextWindow
  const tokens = occupancyTokens ?? current.total
  const pct = window !== undefined && window > 0 ? occupancyPercent(tokens, window) : null
  const parts = anchoredParts(
    officialParts(current, breakdown),
    occupancyTokens !== null && tokens > 0 ? tokens : null,
  )
  return { tokens, window, pct, parts }
}
