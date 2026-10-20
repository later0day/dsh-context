/**
 * The DeepSeek open-platform BALANCE route — the data behind the Context Insights page's header
 * capsule (client/balance.ts).
 *
 * Reaching the platform's one account endpoint (`GET /user/balance`) needs the API key, which by
 * design never rides to the browser, so the HOST reads it and serves the redacted figures. The
 * credential comes from a DEEPSEEK platform settings row and from no other: the provider
 * directory names the API-key model's own row (so a renamed entry still answers), the platform's
 * web rows are the fallback. The endpoint is the platform ROOT — the account route sits at the
 * API root while the endpoints these rows carry live under a path (`/v1/tools`, `/anthropic`),
 * so only the origin counts, and that origin is the DeepSeek endpoint the deployment already
 * talks to. Any missing fact answers a typed `null`, as does a failed or malformed platform
 * read — the capsule renders nothing rather than a stale figure. Identical reads share one
 * outbound fetch while in flight, and nothing outlives it.
 *
 * The transport is Connection's fetch-route registry through a deferred inject, so load order
 * never matters and a harness without the registry simply never arms the route.
 */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** The plugin's balance route, under the authenticated `/api` fence. */
export const BALANCE_ROUTE = '/api/dsh-context/balance'

/** The DeepSeek platform's API-key provider route key. The account route registers
 * `deepseek-account` and holds no API key, so it never serves the balance. */
const DEEPSEEK_PROVIDER = 'deepseek-official'

/** The stock entry ids of the DeepSeek platform's own settings rows: the API-key model row,
 * and the two web rows that carry the same platform credential. */
const DEEPSEEK_SETTINGS_IDS = ['llm-deepseek', 'web-deepseek-api', 'web-search-deepseek']

/** The DeepSeek platform's public API root (`GET /user/balance`). */
const PUBLIC_BASE_URL = 'https://api.deepseek.com'

const FETCH_TIMEOUT_MS = 10_000

/** The harness `settings` service: the Config-form `describe()` projection is the only face served. */
interface SettingsHostFace {
  describe?(options?: { redactSecrets?: boolean }): unknown
}

/** The harness `llm` service: the provider directory names the DeepSeek row, so a renamed
 * entry still answers. */
interface LlmHostFace {
  listConfigurableProviders?(): unknown
}

interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

interface DeepSeekFacts { baseUrl: string; apiKey: string }

/** One DeepSeek platform settings row: the credential ref it names, and the endpoint override
 * it carries. */
interface DeepSeekRow {
  apiKeyEnv: string
  baseURL?: string
}

/** The settings ids that may serve the platform credential, in the order the facts fold prefers
 * them: the row the provider directory names — the authoritative answer, whatever the entry is
 * called — then the stock ids of the DeepSeek platform's own rows. */
function deepseekSettingsIds(ctx: Context): string[] {
  const ids: string[] = []
  const llm = ctx.get('llm') as LlmHostFace | undefined
  if (typeof llm?.listConfigurableProviders === 'function') {
    try {
      const entries = llm.listConfigurableProviders()
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          try {
            const record = asRecord(entry)
            if (record === null || record.provider !== DEEPSEEK_PROVIDER) continue
            const id = record.settingsNs
            if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
          } catch {
            continue
          }
        }
      }
    } catch {
      // The directory is optional: the stock ids below still answer.
    }
  }
  for (const id of DEEPSEEK_SETTINGS_IDS) if (!ids.includes(id)) ids.push(id)
  return ids
}

/** The DeepSeek platform's settings rows, folded from the Config-form `describe()` projection:
 * the credential ref and the endpoint override live at the section root, and only a DeepSeek
 * platform row may serve them. Rows fold in isolation — a hostile row drops whole, valid
 * siblings serve. */
function deepseekRowsOf(ctx: Context): DeepSeekRow[] {
  const settings = ctx.get('settings') as SettingsHostFace | undefined
  if (typeof settings?.describe !== 'function') return []
  let rows: unknown
  try {
    // The projection is read redacted: a row's literal key is a secret this fold has no
    // use for, and the credential ref it does read is not one.
    rows = settings.describe({ redactSecrets: true })
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    try {
      const record = asRecord(row)
      if (record === null) continue
      const id = record.ns
      const value = asRecord(record.value)
      if (typeof id !== 'string' || value === null || byId.has(id)) continue
      byId.set(id, value)
    } catch {
      continue
    }
  }
  const deepseekRows: DeepSeekRow[] = []
  for (const id of deepseekSettingsIds(ctx)) {
    const value = byId.get(id)
    if (value === undefined) continue
    const apiKeyEnv = value.apiKeyEnv
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') continue
    const baseURL = value.baseURL
    deepseekRows.push({
      apiKeyEnv,
      baseURL: typeof baseURL === 'string' && baseURL !== '' ? baseURL : undefined,
    })
  }
  return deepseekRows
}

/** The platform's account root, read off a row's endpoint override: only the origin counts,
 * because the account route sits at the API root while the endpoints carry their own paths. */
function platformRootOf(baseURL: string | undefined): string {
  if (baseURL === undefined) return PUBLIC_BASE_URL
  try {
    const url = new URL(baseURL)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return PUBLIC_BASE_URL
    return url.origin
  } catch {
    return PUBLIC_BASE_URL
  }
}

/** Resolve the connection facts the platform itself serves requests with; `null` whenever any
 * fact is missing. Each DeepSeek row is tried in turn and the first whose credential resolves
 * serves, so a row without a key never sends a request. */
async function resolveFacts(ctx: Context): Promise<DeepSeekFacts | null> {
  const credentials = ctx.get('credentials') as CredentialsHostFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  const tried = new Set<string>()
  for (const row of deepseekRowsOf(ctx)) {
    if (tried.has(row.apiKeyEnv)) continue
    tried.add(row.apiKeyEnv)
    let hit: { value?: unknown } | undefined
    try {
      hit = await resolve(row.apiKeyEnv)
    } catch {
      continue
    }
    const apiKey = typeof hit?.value === 'string' ? hit.value : ''
    if (apiKey === '') continue
    return { baseUrl: platformRootOf(row.baseURL), apiKey }
  }
  return null
}

/** Narrow the platform's payload to the wire value: the total is the two re-proved parts summed,
 * so the viewer's arithmetic is the authority. An entry failing the shape drops whole, and a
 * payload with no valid entry is no balance at all. */
export function balanceOfPayload(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // A hostile entry may throw on property access; it drops whole.
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const granted = amountOf(entry.granted_balance)
      const toppedUp = amountOf(entry.topped_up_balance)
      if (typeof currency !== 'string' || currency === ''
        || granted === null || toppedUp === null) continue
      balances.push({ currency, total: granted + toppedUp, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.is_available === true, balances }
    : null
}

type BalanceFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: BalanceFetcher = (url, init) => fetch(url, init)

let fetcher: BalanceFetcher = defaultFetcher

export function setBalanceFetcher(next: BalanceFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let inFlight: Promise<PlatformBalance | null> | null = null

export function resetBalance(): void {
  inFlight = null
}

/** One platform read for these facts, shared by identical reads already in flight; nothing is
 * remembered, since the balance moves with every billed request. Every failure path — transport,
 * timeout, non-ok status, malformed payload — resolves `null`. */
async function readBalance(facts: DeepSeekFacts): Promise<PlatformBalance | null> {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    let value: PlatformBalance | null = null
    try {
      const response = await fetcher(facts.baseUrl + '/user/balance', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + facts.apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response.ok) value = balanceOfPayload(await response.json())
    } catch {
      // Any failure serves null — the capsule stays hidden.
    }
    return value
  })()
  const settled = inFlight
  try {
    return await settled
  } finally {
    // The `inFlight !== null` guard makes the settled read's own clear the current value's.
    inFlight = null
  }
}

/** Serve the balance route whenever the connection service composes; the registration rides the
 * injected fiber, so unloading withdraws it. */
export function watchBalanceChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {

    const handler = async (): Promise<Response> => {
      const facts = await resolveFacts(ctx)
      const value = facts !== null ? await readBalance(facts) : null
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    }

    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, BALANCE_ROUTE, handler, 'dsh-context: balance route')
  })
}
