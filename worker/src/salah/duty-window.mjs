/** Mirror of src/lib/salah/duty-window.ts — keep constants identical. */

export const MORAL_WINDOW_BEFORE_MIN = 15
export const MORAL_WINDOW_AFTER_MIN = 30
export const MAX_DELAY_MIN = 45

export function dutyWindowEnd(prayerStart) {
  const prayer = new Date(prayerStart).getTime()
  return new Date(prayer + MORAL_WINDOW_AFTER_MIN * 60_000)
}
