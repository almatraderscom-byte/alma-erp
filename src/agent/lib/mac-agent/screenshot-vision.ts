/**
 * P1-8 — the screenshot reaches the AGENT's eyes, not only Boss's (audit §I).
 *
 * `look_mac_app action="screenshot"` has always captured the window and handed
 * back a link. The link is for Boss. The head itself never saw a single pixel:
 * it received a URL, said something plausible about it, and carried on — which
 * is precisely how the audit's test 9 produced "Desktop-এ সেভ হয়েছে" about a
 * file that was never saved.
 *
 * So the capture is READ before the result is returned, and the reading goes in
 * the tool result. Two honest limits, stated because they matter:
 *
 *  - This is a DESCRIPTION produced by a vision model, not the head looking at
 *    the image itself. It is what this codebase already does for Boss's own
 *    uploads (attachment-vision), on proven plumbing, and it is a large step up
 *    from a URL. Native multimodal tool results stay on the list.
 *  - It costs one cheap vision call per screenshot. Failure is not fatal: the
 *    link still goes back, with an honest note that the picture could not be
 *    read — never a silent gap the head can fill with a guess.
 */

/** Owner kill switch — off restores the link-only screenshot exactly. */
export const screenshotVisionEnabled = (): boolean => process.env.MAC_SCREENSHOT_VISION !== 'off'

const READ_PROMPT =
  'You are the eyes of an assistant that is operating this Mac app on its owner\'s behalf. ' +
  'Describe what this window is showing RIGHT NOW, factually and briefly (max ~150 words): ' +
  'which screen/state it is in, the visible text that matters, which controls are on screen, ' +
  'and anything that looks like an error, a dialog, or a confirmation waiting for a click. ' +
  'Do not speculate about what is off-screen. Do not give advice. If the window looks empty, say so.'

const VISION_MODEL = process.env.MAC_SCREENSHOT_VISION_MODEL?.trim() || 'gemini-2.5-flash'

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
}

/**
 * Read a screenshot data URI. Returns null when vision is off, unconfigured, or
 * the call fails — the caller must then say so rather than pretend it looked.
 */
export async function describeScreenshot(dataUri: string): Promise<string | null> {
  if (!screenshotVisionEnabled()) return null
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUri.trim())
  if (!m) return null
  const [, mimeType, base64] = m
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: READ_PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(25_000),
      },
    )
    if (!res.ok) {
      console.warn(`[screenshot-vision] HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as GeminiResponse
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
    return text || null
  } catch (err) {
    console.warn('[screenshot-vision] read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * What the head is told about a capture it cannot see. Explicit, because the
 * alternative — a bare link and silence — is what let it narrate a screen it
 * had never looked at.
 */
export const SCREENSHOT_UNREAD_NOTE =
  'ছবিটা তোলা হয়েছে এবং Boss-কে দেখানো হয়েছে, কিন্তু তুমি নিজে সেটা পড়তে পারোনি — '
  + 'তাই স্ক্রিনে কী আছে সেটা অনুমান করে বোলো না। জানতে হলে `look_mac_app action="tree"` দিয়ে পড়ো।'
