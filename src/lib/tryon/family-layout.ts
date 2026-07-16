/**
 * CS9 — deterministic family layout for PROTECTED compositing.
 *
 * The protected composite never regenerates approved face/garment pixels: the
 * adult try-on shot stays untouched as the BASE (person + background exactly as
 * FASHN rendered them) and the other person is cut out locally and INSERTED
 * beside them at the correct relative height. Only the insert's edge band and
 * a ground-contact ellipse are later harmonized by FLUX Fill.
 *
 * This module is the pure, unit-tested spec. worker/src/family-composite.mjs
 * mirrors the same math (keep in sync) because the worker only learns the
 * person bounding boxes after local segmentation.
 */

export type InsertRole = 'son' | 'daughter' | 'mother' | 'pair'

/**
 * Insert height relative to the base adult's person height (owner-locked
 * anthropometry for the catalogue's age ranges):
 *  - son (7–11)      ≈ 0.62 of the father
 *  - daughter (5–9)  ≈ 0.56 of the adult
 *  - mother/wife     ≈ 0.94 of the husband
 *  - pair            ≈ 1.00 — a whole mother+daughter group moves as one unit,
 *                     already internally scaled; match its TALLEST person to
 *                     the base adult.
 */
export const INSERT_RELATIVE_HEIGHT: Record<InsertRole, number> = {
  son: 0.62,
  daughter: 0.56,
  mother: 0.94,
  pair: 1.0,
}

/** Horizontal gap between the base person and the insert, as a fraction of the
 * base person's height (small positive gap — family stands close). */
export const INSERT_GAP_RATIO = 0.05

export type BBox = { x: number; y: number; width: number; height: number }

export type InsertPlacement = {
  /** target size of the scaled cutout, px */
  width: number
  height: number
  /** top-left position on the base canvas, px */
  x: number
  y: number
  side: 'left' | 'right'
  /** true when the canvas had no room and the insert overlaps the base person */
  cramped: boolean
}

/**
 * Compute where the insert cutout goes:
 *  - scaled so insertHeight = base person height × relative[role]
 *  - feet share the base person's ground line (bottom of their bbox)
 *  - placed beside the base person on the roomier side (or preferSide)
 */
export function planInsertPlacement(args: {
  canvasWidth: number
  canvasHeight: number
  baseBBox: BBox
  insertAspect: number // cutout width/height
  role: InsertRole
  preferSide?: 'left' | 'right'
}): InsertPlacement {
  const { canvasWidth, baseBBox, insertAspect, role } = args
  const rel = INSERT_RELATIVE_HEIGHT[role] ?? 0.6
  const height = Math.round(baseBBox.height * rel)
  const width = Math.round(height * insertAspect)
  const gap = Math.round(baseBBox.height * INSERT_GAP_RATIO)

  const baseline = baseBBox.y + baseBBox.height // shared ground line
  const y = Math.max(0, baseline - height)

  const roomRight = canvasWidth - (baseBBox.x + baseBBox.width)
  const roomLeft = baseBBox.x
  let side: 'left' | 'right' =
    args.preferSide ?? (roomRight >= roomLeft ? 'right' : 'left')
  // If the preferred side genuinely can't fit but the other can, flip.
  const fits = (s: 'left' | 'right') =>
    s === 'right' ? roomRight >= width + gap : roomLeft >= width + gap
  if (!fits(side) && fits(side === 'right' ? 'left' : 'right')) {
    side = side === 'right' ? 'left' : 'right'
  }

  let x: number
  let cramped = false
  if (side === 'right') {
    x = baseBBox.x + baseBBox.width + gap
    if (x + width > canvasWidth) {
      x = Math.max(0, canvasWidth - width)
      cramped = x < baseBBox.x + baseBBox.width * 0.7
    }
  } else {
    x = baseBBox.x - gap - width
    if (x < 0) {
      x = 0
      cramped = width > baseBBox.x - gap + baseBBox.width * 0.3
    }
  }

  return { width, height, x, y, side, cramped }
}

export type HarmonizeMaskSpec = {
  /** edge band thickness around the inserted cutout, px */
  edgeBandPx: number
  /** ground-contact shadow ellipse under the insert (canvas px) */
  ground: { cx: number; cy: number; rx: number; ry: number }
}

/**
 * FLUX Fill may touch ONLY: a thin band around the insert's silhouette (blend
 * seams) and a flat ellipse under the feet (contact shadow). Faces/garments —
 * both the base person's and the insert's interior — stay outside the mask.
 */
export function buildHarmonizeMaskSpec(placement: InsertPlacement): HarmonizeMaskSpec {
  const edgeBandPx = Math.max(6, Math.round(placement.height * 0.015))
  return {
    edgeBandPx,
    ground: {
      cx: placement.x + placement.width / 2,
      cy: placement.y + placement.height,
      rx: Math.round(placement.width * 0.55),
      ry: Math.max(8, Math.round(placement.height * 0.035)),
    },
  }
}

/** Expected people in the final frame per variant — the 100% member-count rule. */
export const EXPECTED_MEMBER_COUNT: Record<string, number> = {
  father_son: 2,
  mother_son: 2,
  mother_daughter: 2,
  father_daughter: 2,
  couple: 2,
  full_family: 4,
}
