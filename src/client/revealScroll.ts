/**
 * Scroll an element's nearest scrollable ancestor so the element tops that
 * scrollport. The jump's landing reveal needs this host-agnostic: the
 * conversation tab scrolls the shared `[data-conversation-scroll]` container
 * while the right Sidebar's scroller differs per generation (dockkit's pane
 * body — a CSS-module class with no stable attribute — on the 0.1.5 line, the
 * tab root itself on the 0.1.7 line), so the walk takes whichever ancestor
 * actually scrolls — overflowing style alone is not enough, a grow-with-
 * content box reports `auto` yet never moves — and the rect delta lands the
 * anchor flush regardless of the container's current position.
 * `document.body` ends the walk: the page itself never scrolls. False —
 * never a throw — when no ancestor scrolls (the layout already shows the
 * element) or the chain turns hostile.
 *
 * @module dsh-context/client/revealScroll
 */

export function revealInScrollParent(anchor: Element): boolean {
  try {
    for (let el = anchor.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      // The OPERATIVE scroller, not just an overflow-styled one: a box that
      // grows with its content (the Context tab's own `.lc-root` on layouts
      // where an OUTER container scrolls) reports auto yet never moves, and
      // taking it here would scroll a no-op while the real scroller waits
      // further up the chain.
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
        return true
      }
    }
  } catch { /* hostile chain: the reveal degrades to nothing */ }
  return false
}
