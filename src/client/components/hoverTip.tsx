/**
 * The dashboard's hover tips — one fixed bubble, portaled to <body>, driven
 * by event delegation off the page root.
 *
 * Why not the harness Tooltip: the Insights page is the `lc-ov` query
 * container, and inline-size containment makes the page the containing block
 * for FIXED descendants — an in-tree fixed bubble (the harness Tooltip's
 * unportaled spelling) would paint sidebar-width away from its anchor, while
 * the primitive's `portal` prop exists only on 0.1.7+. The plugin already
 * portals its own fixed overlays for exactly this trap (the image lightbox,
 * base.css), so the page's tips follow that precedent and stay correct on
 * every supported line.
 *
 * Anchors carry `data-lc-tip` (the label) and optional `data-lc-tip-side`
 * ('top' default, 'bottom'); the zone delegates `mouseover`/`mouseout` and
 * focus/blur capture, so anchors stay plain elements — no per-cell wrapper
 * components. One bubble at a time: it re-anchors on anchor switch, hides on
 * anchor leave, on any zone scroll, on a viewport resize (every anchor just
 * moved), and on unmount; while shown it sets the anchor's
 * `aria-describedby`.
 *
 * @module dsh-context/client/components/hoverTip
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/** The bubble's identity for the anchor's `aria-describedby` (one live bubble at a time). */
const TIP_ID = 'lc-hovertip-bubble'

/** Anchor-to-bubble distance and the viewport margin the bubble clamps inside, in px. */
const GAP = 6
const VIEWPORT_MARGIN = 8

interface ActiveTip {
  anchor: Element
  label: string
  side: 'top' | 'bottom'
  rect: { left: number; top: number; width: number; height: number; bottom: number }
}

/** The bubble's measured spot for one shown tip. */
interface Measured {
  tip: ActiveTip
  left: number
  top: number
}

/** The nearest tip anchor of an event target, if any. */
function anchorOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('[data-lc-tip]') : null
}

function tipOf(anchor: Element): ActiveTip | null {
  const label = anchor.getAttribute('data-lc-tip')
  if (label === null || label === '') return null
  const r = anchor.getBoundingClientRect()
  return {
    anchor,
    label,
    side: anchor.getAttribute('data-lc-tip-side') === 'bottom' ? 'bottom' : 'top',
    rect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom },
  }
}

export interface HoverTipZone {
  /** Spread onto the zone's root element (the page section). */
  zoneProps: {
    onMouseOver: (ev: React.MouseEvent) => void
    onMouseOut: (ev: React.MouseEvent) => void
    onFocusCapture: (ev: React.FocusEvent) => void
    onBlurCapture: (ev: React.FocusEvent) => void
    onScrollCapture: (ev: React.UIEvent) => void
  }
  /** The portaled bubble element, or null while nothing is tipped. */
  bubble: ReactElement | null
}

/**
 * The zone hook: stable delegated handlers plus the portaled bubble. The
 * bubble renders hidden until the layout effect measures it, so it never
 * flashes at an unmeasured spot.
 */
export function useHoverTip(): HoverTipZone {
  const [tip, setTip] = useState<ActiveTip | null>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const show = useCallback((anchor: Element): void => {
    setTip((current) => {
      // Same anchor (moving across its own subtree): keep tip and measure.
      if (current?.anchor === anchor) return current
      current?.anchor.removeAttribute('aria-describedby')
      const next = tipOf(anchor)
      if (next === null) return null
      anchor.setAttribute('aria-describedby', TIP_ID)
      return next
    })
  }, [])

  const hide = useCallback((): void => {
    setTip((current) => {
      current?.anchor.removeAttribute('aria-describedby')
      return null
    })
  }, [])

  // Anchor switching never hides: leaving A for B skips the hide (B's
  // mouseover re-anchors), and moving inside A's own subtree keeps it.
  const onMouseOver = useCallback((ev: React.MouseEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onMouseOut = useCallback((ev: React.MouseEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) hide()
  }, [hide])
  const onFocusCapture = useCallback((ev: React.FocusEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onBlurCapture = useCallback((ev: React.FocusEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) hide()
  }, [hide])
  const onScrollCapture = useCallback((): void => { hide() }, [hide])

  // A viewport resize moves every anchor (the pane re-solves, the content
  // column re-centers): the zone's scroll rule extended — retract rather
  // than float detached off the moved anchor.
  useEffect(() => {
    if (tip === null) return undefined
    const retract = (): void => { hide() }
    window.addEventListener('resize', retract)
    return () => { window.removeEventListener('resize', retract) }
  }, [tip, hide])

  // Measure once per shown tip (the measured record keys on tip identity, so
  // a same-anchor mousemove never re-hides the bubble): center on the anchor,
  // clamp inside the viewport, flip sides when the preferred side overflows.
  useLayoutEffect(() => {
    if (tip === null || measured?.tip === tip) return
    const el = bubbleRef.current
    /* v8 ignore next -- the portal commits its ref before layout effects run,
     * so a null ref here is unreachable; kept as a guard so a future portal
     * change cannot crash the page. */
    if (el === null) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const { rect } = tip
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - VIEWPORT_MARGIN))
    let top = tip.side === 'top' ? rect.top - h - GAP : rect.bottom + GAP
    if (tip.side === 'top' && top < VIEWPORT_MARGIN) top = rect.bottom + GAP
    else if (tip.side === 'bottom' && top + h > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - h - GAP
    setMeasured({ tip, left, top: Math.max(VIEWPORT_MARGIN, top) })
  }, [tip, measured])

  const shown = measured !== null && measured.tip === tip ? measured : null
  return {
    zoneProps: { onMouseOver, onMouseOut, onFocusCapture, onBlurCapture, onScrollCapture },
    bubble: tip === null ? null : createPortal(
      <div
        ref={bubbleRef}
        id={TIP_ID}
        role="tooltip"
        className="lc-tip lc-hovertip"
        style={shown === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: shown.left, top: shown.top, opacity: 1 }}
      >{tip.label}</div>,
      document.body,
    ),
  }
}
