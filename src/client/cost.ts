/**
 * Session-cost estimate — prices the host-folded cumulative billed-token
 * totals (SessionCostUsage) from the client's model-price book
 * (client/modelPrices.ts): the models.dev registry, fetched through
 * @opencode-ai/models. Book rates are USD per 1M tokens; the CNY display
 * converts at the fixed 1 CNY = 0.15 USD, and the total and the tooltip's
 * rates both go through `toCurrency`, so the printed figures can never
 * drift from the math that prices the session. DeepSeek bills a period-based
 * list whose models.dev figures ARE the official off-peak rates: the Host
 * already split those buckets at fold time, so DeepSeek's `peak` buckets
 * price at twice the book rate here (the `off` buckets stay at book) —
 * never any other provider's. A dsh provider id the registry does not know
 * prices through the model-side resolution index (PriceIndex): the vendor
 * branch is picked from registry data — the model's own-vendor SDK package,
 * the org segment of `vendor/model` spellings, the provider an id names —
 * with ambiguous or conflicting candidates pricing nothing.
 */

import type { SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider, modelsDevProviderOf } from '../shared/providers'
import { asRecord, numOf } from './services'

/** The display currencies the stats board ships; the locale picks one. */
export type CostCurrency = 'usd' | 'cny'

/** 1 CNY = 0.15 USD — the fixed CNY-display conversion rate. */
const USD_PER_CNY = 0.15

/** DeepSeek's peak rates are twice the off-peak rates (the official list). */
const PEAK_FACTOR = 2

/**
 * Per-1M-token rates (USD): cache-hit input, cache-miss input, cache
 * write, output (reasoning included). Absent registry fields fall back to
 * the input rate (a provider that publishes no cache prices bills those
 * buckets as plain input).
 */
export interface PriceTriple { hit: number; miss: number; write: number; out: number }

/**
 * The client's price book: models.dev provider id → model id → USD rates,
 * extracted from the registry (modelPrices.ts).
 */
export type ModelPrices = Record<string, Record<string, PriceTriple>>

/**
 * One cross-provider resolution candidate: the carrying provider (models.dev
 * id) with its rates, and whether it is the model's own vendor — a provider
 * whose AI-SDK package is named after itself (`@ai-sdk/anthropic` →
 * `anthropic`); mirrors and gateways ride generic or foreign packages. `mid`
 * is the registry's own model id spelling (the tooltip's listing face).
 */
export interface PriceCandidate { pid: string; mid: string; rate: PriceTriple; primary: boolean }

/**
 * Model-side resolution index over the book: lowercased model id (exact ids
 * plus their `-`-suffix tails, e.g. `k3` under `kimi-k3`) → the providers
 * carrying it. Built once per book load (modelPrices.ts) so a dsh provider id
 * the registry does not know still prices by model id alone — the vendor is
 * picked by data, never by a per-model hardcode.
 */
export interface PriceIndex { byModel: Map<string, PriceCandidate[]> }

/** The delivered book plus the index built over it (one `pricesBookOf` result). */
export interface ModelBook { prices: ModelPrices; index: PriceIndex }

/**
 * One billed model's price: the USD rates and the registry face — the
 * models.dev provider id and branch model id spelling — they resolved from
 * (the listing source the stats board's tooltip prints).
 */
export interface PriceFace { pid: string; mid: string; rate: PriceTriple }

/** A USD amount in the display currency (CNY divides the fixed rate). */
export function toCurrency(usd: number, currency: CostCurrency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

/** Rate equality within the registry's float noise (sync drift prints 0.125000…003). */
function sameRate(a: PriceTriple, b: PriceTriple): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))
  return close(a.hit, b.hit) && close(a.miss, b.miss) && close(a.write, b.write) && close(a.out, b.out)
}

/** One proven candidate rate off a built book branch, or null. */
function rateOfEntry(value: unknown): PriceTriple | null {
  const v: unknown = value
  if (v === null || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  return num(r.hit) && num(r.miss) && num(r.write) && num(r.out)
    ? { hit: r.hit, miss: r.miss, write: r.write, out: r.out }
    : null
}

/**
 * Build the resolution index over a proven book. `npmOf` carries each
 * provider's registry `npm` package (null when absent) — the vendor signal:
 * a provider whose package is `@ai-sdk/<its own id>` is the model's first
 * party, while mirrors and gateways ride `@ai-sdk/openai-compatible` or
 * someone else's package. Suffix tails are indexed alongside exact ids so a
 * short dsh spelling (`k3`) resolves book-wide too.
 */
export function priceIndexOf(prices: ModelPrices, npmOf: Record<string, string | null>): PriceIndex {
  const byModel = new Map<string, PriceCandidate[]>()
  const push = (key: string, cand: PriceCandidate): void => {
    const list = byModel.get(key)
    if (list === undefined) byModel.set(key, [cand])
    else if (!list.some(c => c.pid === cand.pid && sameRate(c.rate, cand.rate))) list.push(cand)
  }
  for (const pid of Object.keys(prices)) {
    const branch = branchOf(prices, pid)
    if (branch === null) continue
    const npm: unknown = npmOf[pid]
    const primary = typeof npm === 'string' && npm.startsWith('@ai-sdk/') && npm.slice('@ai-sdk/'.length) === pid
    for (const mid of Object.keys(branch)) {
      const rate = rateOfEntry(branch[mid])
      if (rate === null) continue
      const lower = mid.toLowerCase()
      const cand: PriceCandidate = { pid, mid, rate, primary }
      push(lower, cand)
      const parts = lower.split('-')
      for (let i = 1; i < parts.length; i++) push(parts.slice(i).join('-'), cand)
    }
  }
  return { byModel }
}

/**
 * The candidate carrying the rate shared by a candidate group, or null: the
 * largest equal-rate group wins, a tie refuses. Agreeing mirrors are noise;
 * disagreeing ones price nothing rather than guess.
 */
function majorityCandidate(cands: PriceCandidate[]): PriceCandidate | null {
  const groups: { cand: PriceCandidate; n: number }[] = []
  for (const c of cands) {
    const g = groups.find(g => sameRate(g.cand.rate, c.rate))
    if (g === undefined) groups.push({ cand: c, n: 1 })
    else g.n++
  }
  groups.sort((a, b) => b.n - a.n)
  return groups.length > 1 && groups[0].n === groups[1].n ? null : groups[0].cand
}

/**
 * Pick one candidate: the model's own vendor (unique or unanimous), then a
 * provider the model id itself names (`deepseek-v4-flash` under `deepseek`),
 * then a lone carrier. Everything else prices null.
 */
function resolveCandidates(lower: string, cands: PriceCandidate[], org: string | null): PriceCandidate | null {
  if (org !== null) {
    // `vendor/model` catalogs (together- and vercel-style route ids): the
    // org segment names the vendor — exactly, or as the registry id behind
    // a variant org (`deepseek-ai` → `deepseek`, `zai-org` → `zai`).
    const named = cands.filter(c => c.pid === org || org.startsWith(c.pid + '-') || (org.length >= 4 && org.startsWith(c.pid)))
    if (named.length > 0) {
      const cand = majorityCandidate(named)
      if (cand !== null) return cand
    }
  }
  const primaries = cands.filter(c => c.primary)
  if (primaries.length > 0) {
    const cand = majorityCandidate(primaries)
    if (cand !== null) return cand
  }
  const prefixed = cands.filter(c => lower.startsWith(c.pid + '-') || lower.startsWith(c.pid + '/'))
  if (prefixed.length > 0) {
    const cand = majorityCandidate(prefixed)
    if (cand !== null) return cand
  }
  return cands.length === 1 ? cands[0] : null
}

/**
 * Resolve a model id book-wide: the full id first, then its last `/`-segment
 * (an org-prefixed dialect whose exact spelling no registry provider lists).
 * Null when every tier refuses.
 */
function resolveRate(index: PriceIndex, model: string): PriceCandidate | null {
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const org = slash > 0 ? lower.slice(0, slash) : null
  for (const key of slash > 0 ? [lower, lower.slice(slash + 1)] : [lower]) {
    const cands = index.byModel.get(key)
    if (cands === undefined) continue
    const cand = resolveCandidates(key, cands, org)
    if (cand !== null) return cand
  }
  return null
}

/** One book branch (a provider's models), as far as runtime can prove it. */
function branchOf(book: ModelPrices, id: string): Record<string, PriceTriple> | null {
  const v: unknown = book[id]
  return v !== null && typeof v === 'object' ? (v as Record<string, PriceTriple>) : null
}

/**
 * One branch's lookup hit — the registry's own model id and its rates, as
 * far as runtime can prove it: exact own key first (the book is untrusted
 * wire data), then case-insensitively, then by id SUFFIX — dsh spells some
 * models short (`k3`) where the registry namespaces them (`kimi-k3`).
 * Several suffix candidates (e.g. `k3` vs a hypothetical `other-k3`) are
 * ambiguous and price nothing.
 */
function lookupFace(models: Record<string, PriceTriple>, model: string): { mid: string; rate: PriceTriple } | null {
  if (Object.hasOwn(models, model)) return { mid: model, rate: models[model] }
  const m = model.toLowerCase()
  let found: { mid: string; rate: PriceTriple } | null = null
  let seen: string | null = null
  for (const id in models) {
    const lower = id.toLowerCase()
    if (lower !== m && !lower.endsWith('-' + m)) continue
    if (seen !== null && seen !== lower) return null
    seen = lower
    found = { mid: id, rate: models[id] }
  }
  return found
}

/**
 * One billed model's price: the USD rates plus the registry face — the
 * models.dev provider id and branch model id spelling — they resolved from
 * (what the stats board prints as the listing source).
 *
 * Resolution: the dsh provider id goes through modelsDevProviderOf (unmapped
 * ids pass through) and prices by model id — exact, case-insensitive, or
 * suffix. A provider the book does not carry falls back to the model-side
 * resolution index, which names the vendor from data (org segment, own-vendor
 * SDK, id prefix, lone carrier) — never from a per-model hardcode. The one
 * vendor-level seam: a `deepseek-` model id prices from DeepSeek's own
 * registry branch first — its listing is the first-party price book (cache
 * rates included), while the model-side tiers can hand the same id to a
 * self-named hosting provider whose flat listing bills cache hits as plain
 * input (azure's `deepseek-v4-pro`, issue #93) — the same specialness the
 * peak/off-peak split already grants DeepSeek.
 */
export function priceFaceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceFace | null {
  if (book === null || book === undefined) return null
  const registryPid = modelsDevProviderOf(provider)
  const direct = branchOf(book.prices, registryPid)
  // A carried provider's own branch is final — an unknown model there prices
  // null (no cross-provider guess).
  if (direct !== null) {
    const found = lookupFace(direct, model)
    return found === null ? null : { pid: registryPid, mid: found.mid, rate: found.rate }
  }
  if (model.toLowerCase().startsWith('deepseek-')) {
    const firstParty = branchOf(book.prices, 'deepseek')
    if (firstParty !== null) {
      const official = lookupFace(firstParty, model)
      if (official !== null) return { pid: 'deepseek', mid: official.mid, rate: official.rate }
    }
  }
  const cand = resolveRate(book.index, model)
  return cand === null ? null : { pid: cand.pid, mid: cand.mid, rate: cand.rate }
}

/** The book's rates for one folded (provider, model) bucket ({@link priceFaceOf} without the face). */
export function priceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceTriple | null {
  return priceFaceOf(book, provider, model)?.rate ?? null
}

/**
 * Price the session's cumulative billed-token totals. Cache reads bill at
 * the hit rate, uncached input at the miss rate, cache writes at the write
 * rate, output (reasoning included) at the out rate; `peak` buckets price
 * at twice the book rate for DeepSeek (the book lists that provider's
 * off-peak rates — the Host splits the period-based list at fold time).
 * Null when nothing was priced (no usage folded, no book yet, or no model
 * the book prices), so the cell can show a dash.
 */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): number | null {
  if (usage === null || usage === undefined || book === null || book === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    // The doubled peak period is DeepSeek's alone (shared/providers): the
    // book lists its off-peak rates, so only the peak bucket multiplies —
    // every other provider bills every bucket at book price.
    const deepseek = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const rate = priceOf(book, provider, model)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        const price = (numOf(bucket.cacheRead) * rate.hit + numOf(bucket.uncached) * rate.miss
          + numOf(bucket.cacheWrite) * rate.write + numOf(bucket.output) * rate.out) / 1e6
        total += deepseek && period === 'peak' ? price * PEAK_FACTOR : price
        any = true
      }
    }
  }
  return any ? toCurrency(total, currency) : null
}

/**
 * The scope's billed-token total: uncached input + cache read/write + output,
 * summed over every billed model and pricing period — the token face of the
 * same buckets the cost estimate prices. Hostile branches skip, the same
 * re-proving the estimator applies.
 */
export function billedTokensOf(usage: SessionCostUsage | null | undefined): number {
  if (usage === null || usage === undefined) return 0
  let total = 0
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        total += numOf(bucket.uncached) + numOf(bucket.cacheRead) + numOf(bucket.cacheWrite) + numOf(bucket.output)
      }
    }
  }
  return total
}

/**
 * Accumulate one usage's buckets into `out`, summing per (provider, model,
 * period). Hostile branches skip (the same re-proving the estimator applies
 * — the merge is a boundary too); true when any bucket record merged, even
 * an all-zero one (the estimator prices it as $0, never a dash).
 */
function mergeInto(out: SessionCostUsage, usage: SessionCostUsage | null | undefined): boolean {
  if (usage === null || usage === undefined) return false
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null || Array.isArray(models)) continue
    const branch = out[provider] ?? (out[provider] = {})
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const target = branch[model] ?? (branch[model] = {})
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        const prev = target[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        target[period] = {
          uncached: prev.uncached + numOf(bucket.uncached),
          cacheRead: prev.cacheRead + numOf(bucket.cacheRead),
          cacheWrite: prev.cacheWrite + numOf(bucket.cacheWrite),
          output: prev.output + numOf(bucket.output),
        }
        any = true
      }
    }
  }
  return any
}

/**
 * Deep-merge session-cost usages into one — the stats board's total-cost
 * scope (the current agent's usage plus every subagent session's) and the
 * subagent fold's accumulation. Null when NO side carried a bucket record,
 * so the caller keeps its dash.
 */
export function mergeCostUsage(...usages: (SessionCostUsage | null | undefined)[]): SessionCostUsage | null {
  const out: SessionCostUsage = {}
  let any = false
  for (const usage of usages) {
    if (mergeInto(out, usage)) any = true
  }
  return any ? out : null
}

export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/** Price-list figure: always two decimals (the tooltip's `¥ XX.XX` rate format). */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return (currency === 'cny' ? '¥' : '$') + amount.toFixed(2)
}
