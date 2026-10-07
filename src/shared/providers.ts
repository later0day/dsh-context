/**
 * The provider-id seam between dsh request envelopes and the models.dev
 * registry: client/cost.ts resolves price-book branches through it, and
 * host/fold.ts uses the DeepSeek resolution to split the session-cost totals
 * into peak/off-peak periods. Only the renames live here — a dsh route key
 * that is not a registry id (user-declared gateways, `claude`/`codex`
 * subscriptions, org-prefixed catalogs) passes through and prices through
 * the model-side resolution index instead (client/cost.ts).
 */

const MODELS_DEV_PROVIDER_IDS: Record<string, string> = {
  // dsh's two native DeepSeek routes share one registry vendor — and one
  // period-based list, so `deepseek-account` must resolve for the fold's
  // peak/off-peak split too.
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
}

/** The models.dev provider id that prices a dsh provider (identity for unmapped ids). */
export function modelsDevProviderOf(dshProviderId: string): string {
  return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId
}

/** Whether a dsh provider prices through DeepSeek's period-based list (peak / half-price off-peak). */
export function isDeepSeekProvider(dshProviderId: string): boolean {
  return modelsDevProviderOf(dshProviderId) === 'deepseek'
}
