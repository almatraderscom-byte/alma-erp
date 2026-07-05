// CS4: Model Creator — generate the brand's FICTIONAL model once per role
// (consistent identity portrait, neutral clothes, front-facing) so the owner
// never needs a real child's photo. Generated once, saved into the Models
// library from the gallery, reused forever.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

const ROLE_PROMPTS: Record<string, string> = {
  father:
    'Studio identity portrait of a fictional Bangladeshi man, mid-30s, warm friendly face, short neat hair and trimmed beard, wearing a PLAIN light-grey crew-neck t-shirt.',
  mother:
    'Studio identity portrait of a fictional Bangladeshi woman, early-30s, warm friendly face, modest simple hijab in a neutral tone, wearing PLAIN neutral clothing.',
  son:
    'Studio identity portrait of a fictional Bangladeshi boy, age 8, bright friendly face, short neat hair, wearing a PLAIN white t-shirt.',
  daughter:
    'Studio identity portrait of a fictional Bangladeshi girl, age 7, bright friendly face, neat tied-back hair, wearing a PLAIN light t-shirt.',
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { role?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }
  const role = String(body.role ?? '')
  if (!ROLE_PROMPTS[role]) return Response.json({ error: 'invalid_role' }, { status: 422 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentPendingAction.create({
    data: {
      conversationId: null,
      type: 'image_gen',
      payload: {
        prompt: [
          ROLE_PROMPTS[role],
          'Full body visible head to shoes, standing straight, arms relaxed, facing the camera directly.',
          'Clean plain light-grey studio background, soft even lighting, photorealistic, sharp focus.',
          'This is a reusable MODEL IDENTITY photo for virtual try-on: neutral expression-friendly smile, no props, no text, no logos.',
        ].join(' '),
        quality: 'pro',
        aspectRatio: '4:5',
        imageSize: '2K',
        creativeStudio: true,
        skipTelegramCard: true,
        studioMode: 'product_to_model',
        provider: 'gemini',
        modelCreator: role,
      },
      summary: `🧑‍🎨 ব্র্যান্ড মডেল তৈরি — ${role}`,
      costEstimate: 0.25,
      status: 'approved',
    },
  })
  return Response.json({ ok: true, pendingActionId: row.id })
}
