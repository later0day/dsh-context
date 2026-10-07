/**
 * The /context modal's dock insets: the shell's sidebar tracks, so the fixed backdrop spans exactly the main column and centers the dialog
 * over it instead of the whole viewport. The only host anchor is the app frame's inline grid template (`<sidebar>px <centre> <rightbar>` —
 * the leading px track is the left sidebar, the trailing px track the right panel's bound: the contract every supported baseline shares;
 * the centre track's spelling differs per generation) found by walking up from the backdrop. On the minmax generations the trailing bound
 * is NOT the solved width: the frame lets the grid squeeze (the centre's declared minimum wins, the right track takes the remainder up to
 * its bound — the frame's own columns solve), so the parsed bound is clamped to the space the centre minimum leaves. Anything unresolved —
 * no frame, unparsable template, a hostile node in the chain — degrades to 0 insets, the full-viewport mask.
 */

/** The dock measure for one backdrop position: the mask insets and the frame to observe for template rewrites. */
export interface DockMeasure {
  /** Mask inset from the viewport's left edge, in px (0 = mask starts at the viewport edge). */
  left: number
  /** Mask inset from the viewport's right edge, in px (0 = mask ends at the viewport edge). */
  right: number
  /** The element owning the inline grid template; null when unresolved (nothing to observe). */
  frame: HTMLElement | null
}

const LEADING_PX_TRACK = /^(\d+(?:\.\d+)?)px/
// The centre track's declared minimum (`minmax(0, 1fr)`, `minmax(400px, 1fr)` — spelling varies per generation, only the number is read).
const CENTRE_MIN_TRACK = /^\s*minmax\(\s*([\d.]+)(?:px)?\s*,/
// The V4 spelling's trailing track closes with a paren after the px.
const TRAILING_PX_TRACK = /(\d+(?:\.\d+)?)px\)?$/

/** Measure the sidebar tracks from the backdrop's ancestor chain, or resolve to the full-viewport mask. */
export function measureDock(start: HTMLElement | null): DockMeasure {
  try {
    for (let el = start?.parentElement ?? null; el !== null; el = el.parentElement) {
      const template = el.style.gridTemplateColumns
      if (template === '') continue
      const trimmed = template.trim()
      const lead = LEADING_PX_TRACK.exec(trimmed)
      if (lead === null) return { left: 0, right: 0, frame: null }
      const trail = TRAILING_PX_TRACK.exec(trimmed)
      // A template of the leading track alone matches both anchors: no right panel track exists to inset.
      if (trail === null || trail.index === 0) return { left: Number(lead[1]), right: 0, frame: el }
      const centreMin = CENTRE_MIN_TRACK.exec(trimmed.slice(lead[0].length))
      const bound = Number(trail[1])
      const centreFloor = centreMin === null ? 0 : Number(centreMin[1])
      return {
        left: Number(lead[1]),
        right: Math.min(bound, Math.max(0, window.innerWidth - Number(lead[1]) - centreFloor)),
        frame: el,
      }
    }
  } catch { /* a hostile node in the chain degrades to the full-viewport mask */ }
  return { left: 0, right: 0, frame: null }
}
