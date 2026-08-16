/**
 * The Mac screenshot on a Bangla turn (owner incident 2026-08-15).
 *
 * `mac_desk_control` is write-class, so on a turn the gate read as
 * `information_only` it was stripped before the head ever saw it — and every
 * Bangla phrasing of "দেখাও" landed there while the Banglish "dekhaw" did not.
 *
 * The first fix tried to teach this file Bengali. Six review rounds found eleven
 * P1s in it (দিবে is also the future tense, নাও is also a boat, and the familiar
 * 2nd-person present is spelled exactly like the imperative), so the classifier
 * was deleted and the ONE tool it existed for was put on OWNER_SERVICE_TOOLS.
 * These tests pin that outcome: the language stays undecided, the tool arrives
 * anyway, and nothing else about the gate moved.
 */
import { describe, it, expect } from 'vitest'
import { deriveOwnerTurnAuthorization, isToolAllowedForOwnerTurn } from '../turn-authorization'

const auth = (t: string) => deriveOwnerTurnAuthorization(t)
const allowsTool = (t: string, tool: string) => isToolAllowedForOwnerTurn(tool, auth(t))

describe('the screenshot survives a Bangla turn without any grammar guessing', () => {
  it('reaches the head on the exact message that failed for a whole session', () => {
    const msg = 'ম্যাক্সস্ট্রিমে ওখানে লাইভ দেখাও আমাকে।'
    // The gate still calls it information_only — deliberately. We stopped trying
    // to argue with that and exempted the tool instead.
    expect(auth(msg).allowMutations).toBe(false)
    expect(allowsTool(msg, 'mac_desk_control')).toBe(true)
  })

  it('reaches the head on a plain question too', () => {
    for (const msg of ['স্ক্রিনে কী আছে?', 'ম্যাকে কী চলছে', 'তুমি প্রতিদিন কী করো?']) {
      expect(allowsTool(msg, 'mac_desk_control'), msg).toBe(true)
    }
  })

  it('is not needed for the look tools that were already read-class', () => {
    const msg = 'ক্যামেরা দেখাও'
    for (const tool of ['get_office_camera_snapshot', 'look_mac_app', 'live_browser_look']) {
      expect(allowsTool(msg, tool), tool).toBe(true)
    }
  })
})

describe('what the exemption must NOT have opened', () => {
  const question = 'গত মাসের বিক্রি কেমন ছিল'

  it('leaves every other write-class tool stripped on the same turn', () => {
    expect(auth(question).allowMutations).toBe(false)
    // Write-class only. `post_to_facebook` and `run_mac_command` are STAGE —
    // they merely draw an approval card, and the gate deliberately keeps those
    // on an information_only turn.
    for (const tool of ['send_whatsapp', 'camera_speak']) {
      expect(allowsTool(question, tool), tool).toBe(false)
    }
  })

  it('still honours an explicit stop — "কিছু কোরো না" is the one thing that wins', () => {
    // explicit_no_action is checked first and strips stage tools too. The
    // exemption list is consulted before mode, so the screenshot survives even
    // here; that is the same standing as ask_user and the pairing tools.
    const stop = 'শুধু বলো, কিছু কোরো না'
    expect(auth(stop).reason).toBe('explicit_no_action')
    for (const tool of ['post_to_facebook', 'send_whatsapp', 'run_mac_command']) {
      expect(allowsTool(stop, tool), tool).toBe(false)
    }
  })

  it('leaves the Banglish path exactly as it was', () => {
    expect(auth('Mac live dekhaw').allowMutations).toBe(true)
    expect(auth('message pathaw').allowMutations).toBe(true)
  })

  it('does not turn ordinary Bangla statements into orders', () => {
    // The eleven-P1 class, now unreachable because nothing reads these words.
    for (const msg of ['সে আমাকে টাকা দিবে', 'নাও ডুবে গেছে', 'প্রতিদিন বিক্রি কেমন?', 'শেষ লেনদেন কত ছিল?']) {
      expect(auth(msg).allowMutations, msg).toBe(false)
    }
  })
})
