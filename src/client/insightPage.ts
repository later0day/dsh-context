/**
 * The Context Insights page — the plugin's first-level panel, a sibling of
 * the shipped Plugins and Automation tasks pages.
 *
 * Two registrations, one identity:
 *   - the full page itself on the layout's root keyed `main` slot, under the
 *     panel key — the shell's center column renders it whenever the panel is
 *     selected (keyed entryKey switching mounts it on entry and unmounts it
 *     on leave, so the page's mount IS its open);
 *   - the sidebar entry on the root list `sidebar.panellist` under the same
 *     id — the shell owns the row (button, label, active state, and the
 *     click that selects the panel), the plugin contributes only the glyph
 *     and the localized label thunk.
 *
 * Both seats ship on every supported line (the `main` conversation panel and
 * the panellist contract are present since 0.1.5-rc.1 — the compat matrix
 * pins both spellings per baseline), so the registrations ride plain
 * `slots.inject` declaration injects, like the conversation tab's.
 *
 * The per-user `insightsEntry` preference gates the pair: 'show' mounts both
 * registrations, 'hide' unwinds them (a hidden entry leaves the page no
 * opener). The watcher mirrors placement.ts's preference-glued mounting;
 * each mount owns its disposers so a preference flip takes down exactly what
 * it drops.
 *
 * @module dsh-context/client/insightPage
 */

import { createElement as h } from 'react'
import { InsightPanelIcon } from './icon'
import type { Translate } from './i18n'
import type { ContextSettings, InsightsEntry } from './settings'
import type { ClientCtx } from './services'

/**
 * The id shared by the sidebar entry and the `main` panel it opens (the
 * layout's MainPanelId domain) — namespaced, like the right-Sidebar kind, so
 * no shipped or foreign panel collides with it.
 */
export const INSIGHT_PANEL_ID = 'dsh-context'

/** The sidebar row's position: after the shipped Plugins (0) and Automation tasks (10) entries. */
export const INSIGHT_PANEL_ORDER = 20

/**
 * Mount the page and its sidebar entry while the preference shows them.
 * @param ctx - client root context carrying `slots` and the locale service.
 * @param settings - the preferences store; the gate re-reads on every publish.
 * @param page - the Insights page component (the root-scope standard kit
 *   arrives on its props, as on every root seat).
 * @param t - the plugin-namespace translate; the label thunk reads it at call
 *   time, so a language switch relabels the sidebar row.
 * @param ns - the plugin's locale namespace, put on both registrations so the
 *   framework synthesizes the `t` seat for the page too.
 * @returns the watcher's disposer (unsubscribes and unwinds any live mount).
 */
export function watchInsightPage(
  ctx: ClientCtx,
  settings: ContextSettings,
  page: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  t: Translate,
  ns: string,
): () => void {
  let mounted = false
  const disposers: (() => void)[] = []
  const own = (result: unknown): void => {
    if (typeof result === 'function') disposers.push(result as () => void)
  }
  const mount = (): void => {
    own(ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: INSIGHT_PANEL_ID, locale: ns },
      page,
    )))
    own(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: INSIGHT_PANEL_ID, order: INSIGHT_PANEL_ORDER, label: () => t('ov.title'), locale: ns },
      // The owner share is the icon's size (and the row's active flag, unread);
      // the registry's component typing widens it to the generic slot props.
      props => h(InsightPanelIcon, { size: typeof props.size === 'number' ? props.size : undefined }),
    )))
  }
  const unmount = (): void => {
    while (disposers.length > 0) disposers.pop()?.()
  }
  const applyEntry = (entry: InsightsEntry): void => {
    if (entry === 'show' && !mounted) {
      mounted = true
      mount()
    } else if (entry === 'hide' && mounted) {
      mounted = false
      unmount()
    }
  }
  applyEntry(settings.insightsEntry())
  const unsubscribe = settings.store.subscribe(() => { applyEntry(settings.insightsEntry()) })
  return () => {
    unsubscribe()
    if (mounted) {
      mounted = false
      unmount()
    }
  }
}
