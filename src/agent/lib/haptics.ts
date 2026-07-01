import { impactLight, impactMedium } from '@/lib/haptics'

/**
 * Agent-chat haptic cues — thin semantic wrappers over the app-wide haptic
 * vocabulary in src/lib/haptics.ts (single implementation; native Capacitor
 * Haptics with web-vibrate fallback lives there).
 */

/** Subtle pulse when the agent starts/finishes a reply — Claude-app feel. */
export function agentReplyHaptic(): void {
  impactLight()
}

/**
 * A single light "tick" used by the loading spinner, fired repeatedly in sync
 * with the animation rhythm.
 */
export function agentTickHaptic(_webMs = 12): void {
  impactLight()
}

/**
 * Voice-navigator cue so the owner can *feel* the mic turn on/off — the same
 * confirmation Siri gives. `strong` (mic ON) fires a Medium impact so it's
 * unmistakable; the soft variant (mic OFF) is a light tick.
 */
export function voiceHaptic(strong = false): void {
  if (strong) impactMedium()
  else impactLight()
}
