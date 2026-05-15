/** ISO A4 at 72 dpi (PDF points) — pixel-perfect 210mm × 297mm */
export const A4_WIDTH_MM = 210
export const A4_HEIGHT_MM = 297

export const A4_WIDTH_PT = (A4_WIDTH_MM / 25.4) * 72
export const A4_HEIGHT_PT = (A4_HEIGHT_MM / 25.4) * 72

export const A4_SIZE: [number, number] = [A4_WIDTH_PT, A4_HEIGHT_PT]

/** Inner padding inside the fixed A4 canvas (points) */
export const A4_PADDING_PT = {
  top: 28,
  bottom: 24,
  horizontal: 32,
}

export const A4_PAGE_CSS = {
  width: `${A4_WIDTH_MM}mm`,
  height: `${A4_HEIGHT_MM}mm`,
} as const
