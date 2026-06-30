/**
 * Live office-camera tool (owner only) — pulls a fresh still from an Imou camera
 * on demand so the owner can ask "office-er ekta chobi dao" / "Work Room dekhao"
 * in chat and get the picture inline.
 *
 * Uses the same Imou client as the idle-detection pilot. The snapshot URL is a
 * short-lived signed JPEG; the head renders it as a markdown image (the in-app
 * chat shows it inline with a download button). Excluded from STAFF_SAFE_TOOLS —
 * never exposed to staff-scoped agent contexts.
 */
import type { AgentTool } from './registry'
import { captureImouSnapshot, downloadSnapshot, listImouCameras } from '@/agent/lib/imou-camera'
import { geminiVisionJson } from '@/agent/lib/vision-analyze'

interface ResolvedCamera {
  deviceId: string
  channelId: string
  name: string
}

// Map common Banglish / Bangla words the owner may use to the English tokens that
// appear in his Imou channel names (Work Room -1, Office Entrance Room, Boss Office Room).
const ALIAS: Record<string, string> = {
  work: 'work',
  workroom: 'work',
  'work room': 'work',
  কাজ: 'work',
  entrance: 'entrance',
  ঢোকার: 'entrance',
  গেট: 'entrance',
  gate: 'entrance',
  dhokar: 'entrance',
  boss: 'boss',
  বস: 'boss',
  owner: 'boss',
  মালিক: 'boss',
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9ঀ-৿]+/g, ' ').trim()
}

/** Resolve a friendly camera name to a device/channel. Defaults to IMOU_DEVICE_ID. */
async function resolveCamera(query?: string): Promise<ResolvedCamera | null> {
  let cams: Awaited<ReturnType<typeof listImouCameras>> = []
  try {
    cams = await listImouCameras()
  } catch {
    // List failed — fall back to the default device only.
  }
  const def = (process.env.IMOU_DEVICE_ID ?? '').trim()

  const q = norm(query ?? '')
  if (!q) {
    const match = cams.find((c) => c.deviceId === def)
    if (match) return { deviceId: match.deviceId, channelId: match.channelId, name: match.channelName }
    return def ? { deviceId: def, channelId: '0', name: 'Work Room -1' } : null
  }

  // Build the set of search hints: the query words + any alias mappings.
  const hints = new Set<string>(q.split(' ').filter(Boolean))
  for (const [k, v] of Object.entries(ALIAS)) {
    if (q.includes(norm(k))) hints.add(v)
  }

  let best: { cam: ResolvedCamera; score: number } | null = null
  for (const c of cams) {
    const name = norm(c.channelName)
    let score = 0
    for (const h of hints) if (h.length >= 2 && name.includes(h)) score += 1
    if (score > 0 && (!best || score > best.score)) {
      best = { cam: { deviceId: c.deviceId, channelId: c.channelId, name: c.channelName }, score }
    }
  }
  if (best) return best.cam

  // No name match — fall back to the default camera so the owner still gets a frame.
  const match = cams.find((c) => c.deviceId === def)
  if (match) return { deviceId: match.deviceId, channelId: match.channelId, name: match.channelName }
  return def ? { deviceId: def, channelId: '0', name: 'Work Room -1' } : null
}

interface FrameDescription {
  people_count: number
  summary_bn: string
}

const get_office_camera_snapshot: AgentTool = {
  name: 'get_office_camera_snapshot',
  description:
    'Pull a LIVE still photo from an office Imou camera on demand and show it to the owner. ' +
    'Use when the owner asks to see the office / a room / staff right now (e.g. "office-er chobi dao", ' +
    '"Work Room dekhao", "ke ke ache dekho"). camera is an optional room name — "work" (Work Room, default), ' +
    '"entrance" (Office Entrance), or "boss" (Boss Office); omit it for the default Work Room camera. ' +
    'Set describe=true to also get a short Bangla note on how many people are visible and what they appear to be doing. ' +
    'IMPORTANT: after this returns, show the picture to the owner by emitting it as a markdown image ' +
    '![camera](imageUrl) using the returned imageUrl, so it renders inline in the chat. Owner only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      camera: {
        type: 'string',
        description: 'Optional room name: "work" (default Work Room), "entrance", or "boss".',
      },
      describe: {
        type: 'boolean',
        description: 'If true, also analyse the frame and return a short Bangla summary (people count + activity).',
      },
    },
  },
  handler: async (input) => {
    const cam = await resolveCamera(input.camera ? String(input.camera) : undefined)
    if (!cam) {
      return { success: false, error: 'ক্যামেরা configure করা নেই (IMOU_DEVICE_ID missing)।' }
    }

    let snap
    try {
      snap = await captureImouSnapshot(cam.deviceId, cam.channelId)
    } catch (err) {
      return { success: false, error: `ক্যামেরা থেকে ছবি আনা গেল না: ${err instanceof Error ? err.message : String(err)}` }
    }

    let description: string | undefined
    let peopleCount: number | undefined
    if (input.describe === true) {
      try {
        const { base64, mimeType } = await downloadSnapshot(snap.url)
        const res = await geminiVisionJson<FrameDescription>({
          prompt:
            'You are looking at a still frame from an office CCTV camera. Return ONLY JSON: ' +
            '{"people_count": <int>, "summary_bn": "<one short sentence in Bangla describing how many people are visible and what they appear to be doing>"}. ' +
            'Be factual and neutral. If no person is visible, people_count=0.',
          imageBase64: base64,
          mimeType,
          costKind: 'vision_office_snapshot',
          maxTokens: 256,
        })
        description = res.summary_bn
        peopleCount = res.people_count
      } catch {
        // Description is best-effort — still return the image even if vision fails.
      }
    }

    return {
      success: true,
      data: {
        camera: cam.name,
        imageUrl: snap.url,
        capturedAt: snap.capturedAt.toISOString(),
        peopleCount,
        description,
        note: 'ছবিটা ওনারকে দেখাতে markdown image হিসেবে দাও: ![' + cam.name + '](imageUrl)। URL ১ ঘণ্টা পরে expire হবে।',
      },
    }
  },
}

export const CAMERA_TOOLS: AgentTool[] = [get_office_camera_snapshot]
