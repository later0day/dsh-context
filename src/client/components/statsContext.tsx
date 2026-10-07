/**
 * The Context card: the session as a flow diagram — the session node center
 * stage, fed by the two source nodes on the left (the user's own inputs and
 * the context events the host applied, broken down by kind) and draining
 * into the two effect nodes on the right (the live tool calls with their
 * most-called ranking, and the Agent Team ledger: the family's billed-token
 * and estimated-cost totals, then one row per scope — the current agent and
 * the subagent subtree, its session count included).
 * Measured bezier ribbons connect the nodes (a wide translucent band plus a
 * traveling dash of the same hue — element flow, not a conservative Sankey):
 * left→right on a wide card, top→bottom once the container query in
 * stats.css folds the three zones (the component flips the geometry at the
 * same width). The subagent share folds out of the session-list snapshot
 * (`makeSubagentCost` below); a harness without the outward sessions service
 * renders the family figure alone.
 *
 * Count figures only: nothing here is part of a spendable whole, so no pie —
 * proportions live in the composition card, the event rows themselves live
 * on the events card (contextView.tsx), and the token figures (the session's
 * cache-hit share among them) live on the Token card. The cost node prices
 * the host-folded cumulative billed totals (complete session logs, never
 * trimmed) from the models.dev price book (modelPrices.ts) in the locale's
 * currency; its hover bubbles (a '?' marker + styled DOM tip) explain each
 * scope and list the per-1M-token rates of the models the family actually
 * billed, straight from the same book (cost.ts), so printed rates can never
 * drift from the math. A book that has not loaded (or failed) dashes the
 * figures and notes the outage.
 *
 * The counts arrive precomputed: the split-generation wire head carries them
 * (shared/types.ts `TimelineCounts` — computed over the retained records),
 * and the caller derives them from the collections on the inline generation
 * (`countsOfRecords`). The card itself never touches the collections.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, SurfaceNode, TimelineCounts } from '../../shared/types'
import { estimateSessionCost, billedTokensOf, formatCost, formatPriceRate, mergeCostUsage, priceFaceOf, toCurrency } from '../cost'
import type { CostCurrency, ModelBook, PriceFace } from '../cost'
import { sessionsFaceOf, subagentCostFoldOf } from '../agentTree'
import type { AgentHeads } from '../agentHeads'
import { useSessionsSnapshot } from '../agentHeads'
import { useModelPrices } from '../modelPrices'
import { asRecord, type ClientCtx } from '../services'
import { isDeepSeekProvider } from '../../shared/providers'
import type { ViewKit } from '../viewkit'

/** One billed model's tooltip block: the usage key and the registry face its price resolved to. */
interface PriceRow { key: string; face: PriceFace }

/** The four billed buckets of a price block, in display order, with their label keys. */
const BANDS: readonly (readonly [keyof PriceFace['rate'], string])[] = [
  ['hit', 'stats.costHit'],
  ['miss', 'stats.costMiss'],
  ['write', 'stats.costWrite'],
  ['out', 'stats.costOut'],
]

/**
 * The billed models' price blocks — the usage keys priced against the book,
 * in fold order, each carrying the registry face (models.dev provider id ·
 * model id) its rates resolved from. Hostile branches skip; unpriced models
 * drop (their buckets simply do not contribute).
 */
function priceRowsOf(usage: SessionCostUsage | undefined, book: ModelBook | null): PriceRow[] {
  if (usage === undefined || book === null) return []
  const rows: PriceRow[] = []
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    /* v8 ignore next 1 -- the fold's inputs are mergeCostUsage's own output
       (hostile branches dropped at the merge), so a non-record branch never
       reaches here; the guard stays for the helper's own contract. */
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const face = priceFaceOf(book, provider, model)
      if (face === null) continue
      rows.push({ key: provider + '/' + model, face })
    }
  }
  return rows
}

/**
 * The inline generation's counter derivation — the exact tally the card ran
 * over the served collections before the split (distinct turn values, record
 * count, per-kind event tallies). The host's split-generation counts match
 * it by construction (fold.ts buildTimelineHead).
 */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes }
}

/**
 * The stats board's subagent-subtree figures: the merged billed-token usage
 * (null = nothing reported yet — no subagents, no usage, or no sessions face
 * on this harness) and the discovered descendant count (cold ones included —
 * a subagent is one whether or not its usage priced).
 */
export interface SubagentStats {
  usage: SessionCostUsage | null
  count: number
}

/**
 * The stats board's subagent seat: the subtree figures folded from the
 * session-list snapshot's warm rows (`subagentCostFoldOf`) with fetched slim
 * heads standing in for cold relatives.
 */
export function makeSubagentCost(
  ctx: ClientCtx,
  heads: AgentHeads,
): (sessionId: string | undefined) => SubagentStats {
  return function useSubagentCost(sessionId: string | undefined): SubagentStats {
    // Resolved lazily at mount: a deployment without the outward sessions
    // service simply prices no subagent cost.
    const face = useMemo(() => sessionsFaceOf(ctx), [])
    const snapshot = useSessionsSnapshot(face)
    const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())
    const fold = useMemo(
      () => subagentCostFoldOf(snapshot, sessionId, landed),
      [snapshot, sessionId, landed],
    )
    // Fetch every cold descendant's slim head through the shared page-scope
    // cache; a landed head re-folds the subtree with its usage. Same value →
    // same state: the identity bail-out keeps a settled replay on every
    // snapshot tick from looping.
    useEffect(() => {
      for (const id of fold.cold) {
        void heads.headOf(id).then((head) => {
          if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
        }).catch(() => {})
      }
    }, [fold, heads])
    return { usage: fold.usage, count: fold.count }
  }
}

/** The five flow nodes' registry keys, in render order. */
type FlowNodeKey = 'inputs' | 'events' | 'session' | 'tools' | 'cost'

const FLOW_NODES: readonly FlowNodeKey[] = ['inputs', 'events', 'session', 'tools', 'cost']

/** A node's box relative to the flow root, in px. */
interface FlowBox { x: number; y: number; w: number; h: number }

/** One link's rendered path and its element color. */
interface FlowLink { d: string; color: string }

/** An anchor on a box edge: the point plus the outward normal (the curve's tangent direction). */
interface Anchor { x: number; y: number; dx: number; dy: number }

/**
 * The narrow-fold width, paired with the `@container lc-card (max-width: …)`
 * rule in stats.css: the container's content box IS the flow root's own width
 * (it fills the card's content box), so the component's `clientWidth` read and
 * the query can never disagree about the mode.
 */
const FLOW_FOLD_PX = 559

/**
 * The flow topology: the session node center stage, the two source nodes
 * feeding it and the two effect nodes draining it, each link colored by its
 * element (the token composition palette, categories.ts). The fractional
 * attachments fan the pairs apart on the session node (⅓ and ⅔) so the
 * ribbons merge without stacking; the side nodes attach at their centers.
 * Non-conservative by design — every ribbon is the same width whatever the
 * tally behind it.
 */
const FLOW_LINKS: readonly { from: FlowNodeKey; to: FlowNodeKey; fromAt: number; toAt: number; color: string }[] = [
  { from: 'inputs', to: 'session', fromAt: 0.5, toAt: 1 / 3, color: 'var(--color-green-500)' },
  { from: 'events', to: 'session', fromAt: 0.5, toAt: 2 / 3, color: 'var(--color-purple-500)' },
  { from: 'session', to: 'tools', fromAt: 1 / 3, toAt: 0.5, color: 'var(--color-teal-500)' },
  { from: 'session', to: 'cost', fromAt: 2 / 3, toAt: 0.5, color: 'var(--color-pink-500)' },
]

/** The events card's kind pills, tinted by its own kind semantics (events.css `.lc-kind-*`). */
const EVENT_PILLS: readonly { kind: 'inject' | 'compaction' | 'prune'; tally: keyof TimelineCounts; cls: string }[] = [
  { kind: 'inject', tally: 'injects', cls: 'lc-kind-inject' },
  { kind: 'compaction', tally: 'compactions', cls: 'lc-kind-compaction' },
  { kind: 'prune', tally: 'prunes', cls: 'lc-kind-prune' },
]

/**
 * The per-tool tally behind the tool card's pills, folded over the LIVE
 * surface with the host's own predicate (fold.ts `toolCalls`: tool-result
 * nodes, plus skill nodes carrying a tool) — the pills' sum matches the
 * head's `toolCalls` figure by construction, minus any result the fold
 * stamped no name on (such a node counts toward the head's figure but has
 * no pill to ride). Sorted by count desc, then name asc for a stable
 * display; hostile shapes skip rather than throw.
 */
export function toolTallyOf(nodes: readonly SurfaceNode[]): [string, number][] {
  const tally = new Map<string, number>()
  for (const n of nodes) {
    if (n.cat !== 'tool' && !(n.cat === 'skill' && n.tool !== undefined)) continue
    if (typeof n.tool !== 'string' || n.tool === '') continue
    tally.set(n.tool, (tally.get(n.tool) ?? 0) + 1)
  }
  return [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/** The stats card's props (the factory's return type and the inner component share them). */
interface StatsContextProps {
  /** The session-shape tally (host-precomputed on the split generation). */
  counts: TimelineCounts
  /** The whole-session human-input tally (the user's messages + question answers; absent on older hosts). */
  humanInputs?: number
  /** Tool calls with a result live in the current context (absent on older hosts). */
  toolCalls?: number
  /** The whole-session file-op tallies (op counts by kind), for the I/O card's pills. */
  files: { reads: number; writes: number; searches: number; images: number }
  /** The live-surface per-tool call tally (`toolTallyOf`), count-desc. */
  tools: readonly (readonly [string, number])[]
  cost?: SessionCostUsage
  locale: string
  /** The current session id, anchoring the subagent-cost fold (absent = nothing to fold). */
  sessionId?: string
}

/** The anchor at fraction `at` along one box edge, with the edge's outward normal. */
export function flowAnchor(box: FlowBox, side: 'left' | 'right' | 'top' | 'bottom', at: number): Anchor {
  switch (side) {
    case 'left': return { x: box.x, y: box.y + box.h * at, dx: -1, dy: 0 }
    case 'right': return { x: box.x + box.w, y: box.y + box.h * at, dx: 1, dy: 0 }
    case 'top': return { x: box.x + box.w * at, y: box.y, dx: 0, dy: -1 }
    case 'bottom': return { x: box.x + box.w * at, y: box.y + box.h, dx: 0, dy: 1 }
  }
}

/**
 * The Sankey-flavored connector between two anchors: a cubic whose tangents
 * leave along the source anchor's outward normal and enter AGAINST the
 * target's (the end control point sits at `b + b.normal·k`, so the path
 * arrives moving into the node), the control distance half the axis gap
 * (floored so near neighbors still bow visibly).
 */
export function flowCurve(a: Anchor, b: Anchor): string {
  const k = Math.max(18, (a.dx !== 0 ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) / 2)
  return `M ${a.x} ${a.y} C ${a.x + a.dx * k} ${a.y + a.dy * k} ${b.x + b.dx * k} ${b.y + b.dy * k} ${b.x} ${b.y}`
}

/**
 * All four links' paths over the measured node boxes. Horizontal mode flows
 * left→right; the narrow fold stacks the three zones and flows top→bottom —
 * same DOM, the stats.css container query flips the layout at FLOW_FOLD_PX
 * and the caller passes the matching orientation. Sources always attach on
 * their trailing edge, targets on their leading one (the session node is a
 * target of the left/top pair and the source of the right/bottom pair).
 */
export function measureFlow(boxes: Record<FlowNodeKey, FlowBox>, horizontal: boolean): FlowLink[] {
  const fromSide = horizontal ? 'right' as const : 'bottom' as const
  const toSide = horizontal ? 'left' as const : 'top' as const
  return FLOW_LINKS.map(link => ({
    d: flowCurve(flowAnchor(boxes[link.from], fromSide, link.fromAt), flowAnchor(boxes[link.to], toSide, link.toAt)),
    color: link.color,
  }))
}

export function makeStatsContext(
  kit: ViewKit,
  useSubagentCost: (sessionId: string | undefined) => SubagentStats,
): (props: StatsContextProps) => ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: StatsContextProps): ReactElement {
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const { book, failed } = useModelPrices()
    // Both cost figures price the same host-folded cumulative totals, at one
    // scope each: the family total (the current agent's own usage plus every
    // subagent session's) in the cost card's header, the subagents' share
    // alone in the split pill. The subtree's session count rides the session
    // node's third figure.
    const sub = useSubagentCost(props.sessionId)
    const subUsage = sub.usage
    const usage = mergeCostUsage(props.cost, subUsage) ?? undefined
    const cost = estimateSessionCost(usage, book, currency)
    const subCost = estimateSessionCost(subUsage, book, currency)
    const fmtRate = (usd: number): string => formatPriceRate(toCurrency(usd, currency), currency)
    const rows = priceRowsOf(usage, book)
    const subRows = priceRowsOf(subUsage ?? undefined, book)
    // DeepSeek's peak/off-peak scheme is explained only when the tip's own
    // scope actually billed a DeepSeek provider — other sessions see nothing
    // of it.
    const deepseek = usage !== undefined && Object.keys(usage).some(p => isDeepSeekProvider(p))
    const subDeepseek = subUsage !== null && Object.keys(subUsage).some(p => isDeepSeekProvider(p))
    // Usage folded but nothing priced (the book has not loaded, or carries
    // none of this scope's models): say so instead of a bare dash.
    const unpriced = rows.length === 0 && usage !== undefined && Object.keys(usage).length > 0
      && (failed || book !== null)
    const subUnpriced = subRows.length === 0 && subUsage !== null && (failed || book !== null)
    // One scope's price table: the billed buckets' rates at the book's list
    // per model — a zero list price carries no information, so its band drops
    // (free/token-plan listings keep only their listing line) — each block
    // closed by the listing line naming the registry face (provider id ·
    // model id) the rates resolved from.
    const pricesBlock = (blocks: PriceRow[]): ReactNode =>
      blocks.length > 0 ? (
        <span key="prices" className="lc-stat-tip-prices">
          <span className="lc-stat-tip-head">{t('stats.costPriceHead')}</span>
          {blocks.map(r => (
            <span key={r.key} className="lc-stat-tip-row">
              {BANDS.filter(([bucket]) => r.face.rate[bucket] > 0).map(([bucket, label]) => (
                <span key={bucket} className="lc-stat-tip-band">
                  <i>{t(label)}</i>
                  {' '}
                  <b>{fmtRate(r.face.rate[bucket])}</b>
                </span>
              ))}
              <span className="lc-stat-tip-by">{t('stats.costPriceBy', { p: r.face.pid, m: r.face.mid })}</span>
            </span>
          ))}
        </span>
      ) : null
    // The shared footnotes: the CNY conversion note in the CNY display, and
    // DeepSeek's peak-window scheme when the scope billed a DeepSeek provider.
    const notes = (deep: boolean): ReactElement[] =>
      [
        currency === 'cny' ? <span key="cny">{t('stats.costTipCny')}</span> : null,
        deep ? <span key="peak">{t('stats.costTipDeepseek')}</span> : null,
      ].filter((el): el is ReactElement => el !== null)
    const costTip: ReactNode = [
      t('stats.costTip'),
      <span key="billed" className="lc-stat-tip-row">{t('stats.billedTip')}</span>,
      pricesBlock(rows),
      ...notes(deepseek),
      unpriced ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    // The subagents' own share: scope explanation, its own price table, then
    // the outage note when the subagents' models priced against nothing.
    const subTip: ReactNode = [
      t('stats.subCostTip'),
      <span key="billed" className="lc-stat-tip-row">{t('stats.billedTip')}</span>,
      pricesBlock(subRows),
      ...notes(subDeepseek),
      subUnpriced ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    // The five nodes' measured boxes drive the connector overlay: a no-deps
    // layout effect re-measures after every render (a same-string bail-out
    // keeps it loopless), and a ResizeObserver tick covers pane drags that
    // change no prop.
    const flowRef = useRef<HTMLDivElement | null>(null)
    const nodeEls = useRef(new Map<FlowNodeKey, HTMLDivElement>())
    const [links, setLinks] = useState<FlowLink[]>([])
    const [, setResizeTick] = useState(0)
    const nodeRef = (key: FlowNodeKey) => (el: HTMLDivElement | null): void => {
      if (el === null) nodeEls.current.delete(key)
      else nodeEls.current.set(key, el)
    }
    useLayoutEffect(() => {
      const root = flowRef.current
      /* v8 ignore next 1 -- the effect only runs while mounted, and the card always renders the flow root. */
      if (root === null) return
      const rootBox = root.getBoundingClientRect()
      const boxes = {} as Record<FlowNodeKey, FlowBox>
      for (const key of FLOW_NODES) {
        /* v8 ignore start -- the five nodes render before this layout effect, so every key resolves. */
        const el = nodeEls.current.get(key)
        if (el === undefined) return
        /* v8 ignore stop */
        const r = el.getBoundingClientRect()
        boxes[key] = { x: r.left - rootBox.left, y: r.top - rootBox.top, w: r.width, h: r.height }
      }
      const next = measureFlow(boxes, root.clientWidth > FLOW_FOLD_PX)
      setLinks(prev => (prev.length === next.length && prev.every((l, i) => l.d === next[i].d && l.color === next[i].color) ? prev : next))
    })
    /* v8 ignore start -- jsdom has neither ResizeObserver nor layout: tests pin the geometry through measureFlow's unit tests. */
    useEffect(() => {
      const root = flowRef.current
      if (root === null || typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => { setResizeTick(tick => tick + 1) })
      observer.observe(root)
      return () => { observer.disconnect() }
    }, [])
    /* v8 ignore stop */
    // One card's header: the title (with the '?' marker when a tip rides)
    // left and the bold total right — as a div, or as an anchor opening the
    // models.dev provider listing in a new tab when the caller hands a
    // destination (the tooltip still frames and reveals off this same row).
    const head = (label: string, total: ReactNode, tip?: ReactNode, href?: string): ReactElement => {
      const body = (
        <>
          <span className="lc-flow-label">
            {label}
            {tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
          </span>
          <b className="lc-flow-total">{total}</b>
          {tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{tip}</span>}
        </>
      )
      const className = 'lc-flow-head' + (tip === undefined ? '' : ' lc-stat-tipped group/tip')
      return href === undefined
        ? <div className={className}>{body}</div>
        : <a className={className} href={href} target="_blank" rel="noreferrer noopener">{body}</a>
    }
    // One pill: the label over the bold tally, tinted when the caller carries
    // a kind class, dimmed on a zero count (the card's total already reads),
    // '?'-tipped when a tip rides. The label keys the pill — unique within
    // every card's row.
    const pill = (label: string, value: number, cls = '', tip?: ReactNode): ReactElement => (
      <span key={label} className={'lc-flow-pill' + cls + (value === 0 ? ' lc-flow-pill-dim' : '') + (tip === undefined ? '' : ' lc-stat-tipped group/tip')}>
        <span className="lc-flow-pill-label">
          {label}
          {tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
        </span>
        <b>{fmt(value)}</b>
        {tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{tip}</span>}
      </span>
    )
    // The cost card links to the listing when ONE models.dev provider priced
    // the whole scope — the natural "check these rates" destination. A
    // multi-provider scope names each face in the tooltip instead and stays
    // unlinked.
    const costPids = new Set(rows.map(r => r.face.pid).filter(p => p !== ''))
    const costHref = costPids.size === 1 ? 'https://models.dev/providers/' + [...costPids][0] + '/' : undefined
    const ownCost = estimateSessionCost(props.cost, book, currency)
    // The team ledger's token faces, off the same billed buckets the figures
    // price: the family's total, the current agent's own, the subagents'.
    const familyTokens = billedTokensOf(usage)
    const ownTokens = billedTokensOf(props.cost)
    const subTokens = billedTokensOf(subUsage)
    // One scope's token/cost figure pair — the ledger rows' right side.
    const pair = (tokens: number, costText: string): ReactElement => (
      <span className="lc-flow-pair"><b>{fmt(tokens)}</b><i>/</i><b>{costText}</b></span>
    )
    const costText = cost === null ? '—' : formatCost(cost, currency)
    const ownText = ownCost === null ? '—' : formatCost(ownCost, currency)
    const subText = subCost === null ? '—' : formatCost(subCost, currency)
    // The I/O card's total: the user's own inputs plus every file op.
    const ioTotal = (props.humanInputs ?? 0) + props.files.reads + props.files.writes + props.files.searches + props.files.images
    // The tool card: the head's live tally figure (the tools' own tally sums
    // as the fallback on hosts too old to carry it), the three most-called
    // tools as pills, and an overflow pill counting the rest.
    const toolTotal = props.toolCalls ?? props.tools.reduce((sum, [, n]) => sum + n, 0)
    const topTools = props.tools.slice(0, 3)
    const moreTools = props.tools.length - topTools.length
    return (
      <div className="lc-card lc-col-stats flex-[3] min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        <div className="lc-stats lc-flow" ref={flowRef}>
          {/* The connector overlay: under the nodes (they carry z-index), in
              flow order so the traveling dashes read left→right / top→bottom. */}
          <svg className="lc-flow-svg" aria-hidden="true">
            {links.map((l, i) => (
              // Fixed four-link set in a fixed order: the index IS the identity
              // (zero-measured boxes produce identical d strings — jsdom, SSR).
              <g key={i}>
                <path className="lc-flow-ribbon" d={l.d} stroke={l.color} />
                <path className="lc-flow-dash animate-lc-agent-flow motion-reduce:animate-none" d={l.d} stroke={l.color} />
              </g>
            ))}
          </svg>
          <div className="lc-flow-col">
            <div className="lc-flow-node" ref={nodeRef('inputs')}>
              {head(t('stats.io'), fmt(ioTotal))}
              {/* Searches and image reads pill only when they happened — two
                  permanently dimmed pills are noise, these three zero honestly. */}
              <div className="lc-flow-pills">
                {pill(t('stats.humanInputs'), props.humanInputs ?? 0, '', t('stats.humanInputsTip'))}
                {pill(t('files.kind.read'), props.files.reads)}
                {pill(t('files.kind.write'), props.files.writes)}
                {props.files.searches > 0 ? pill(t('files.kind.search'), props.files.searches) : null}
                {props.files.images > 0 ? pill(t('files.kind.image'), props.files.images) : null}
              </div>
            </div>
            <div className="lc-flow-node" ref={nodeRef('events')}>
              {head(t('stats.events'), fmt(props.counts.injects + props.counts.compactions + props.counts.prunes))}
              <div className="lc-flow-pills">
                {EVENT_PILLS.map(p => pill(t('kind.' + p.kind), props.counts[p.tally], ' lc-flow-pill-tint ' + p.cls))}
              </div>
            </div>
          </div>
          <div className="lc-flow-mid">
            <div className="lc-flow-node lc-flow-self" ref={nodeRef('session')}>
              <span className="lc-flow-label">{t('stats.session')}</span>
              <span className="lc-flow-self-stats">
                <span className="lc-flow-kv"><b>{fmt(props.counts.turns)}</b><i>{t('stats.turns')}</i></span>
                <span className="lc-flow-kv"><b>{fmt(props.counts.steps)}</b><i>{t('stats.steps')}</i></span>
                <span className="lc-flow-kv"><b>{fmt(sub.count)}</b><i>{t('stats.subagents')}</i></span>
              </span>
            </div>
          </div>
          <div className="lc-flow-col lc-flow-col-r">
            <div className="lc-flow-node" ref={nodeRef('tools')}>
              {head(t('stats.toolCalls'), fmt(toolTotal))}
              {topTools.length > 0
                ? (
                  <div className="lc-flow-pills">
                    {topTools.map(([name, n]) => (
                      <span key={name} className="lc-flow-pill" title={name}>
                        <span className="lc-flow-pill-label">{name}</span>
                        <b>{fmt(n)}</b>
                      </span>
                    ))}
                    {moreTools > 0
                      ? <span className="lc-flow-pill lc-flow-pill-dim"><span className="lc-flow-pill-label">{t('stats.toolsMore', { n: moreTools })}</span></span>
                      : null}
                  </div>
                )
                : null}
            </div>
            <div className="lc-flow-node" ref={nodeRef('cost')}>
              {head(t('stats.team'), pair(familyTokens, costText), costTip, costHref)}
              {/* The team ledger: one row per scope — the current agent itself,
                  then the subagent subtree (its session count from the same
                  fold). A scope with nothing billed reads 0 tokens / a dashed
                  cost (the price book's outage note lives in the tips). */}
              <div className="lc-flow-rows">
                <div className="lc-flow-row">
                  <span className="lc-flow-row-label">{t('stats.currentAgent')}</span>
                  {pair(ownTokens, ownText)}
                </div>
                <div className="lc-flow-row lc-stat-tipped group/tip">
                  <span className="lc-flow-row-label">
                    {t('stats.teamSubs', { n: sub.count })}
                    <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                  </span>
                  {pair(subTokens, subText)}
                  <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{subTip}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
