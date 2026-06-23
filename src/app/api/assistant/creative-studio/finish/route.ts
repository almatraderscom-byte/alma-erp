/**
 * POST /api/assistant/creative-studio/finish
 *
 * On-demand "finishing": stamp the brand frame (real logo + colours + fonts from
 * the brand identity) onto ONE image, with the product code + hook the owner typed
 * for THAT image. Works on a generated gallery image or any uploaded image — the
 * original is never touched, a separate framed copy is produced.
 *
 * Code + hook are per-image inputs here (NOT a global setting) — that was the
 * owner's correction: the same code/hook must not sit on every image.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { applyBrandFrame } from '@/lib/content-engine/brand-frame'
import type { LifestyleLayoutOverrides } from '@/lib/content-engine/lifestyle-layout'
import { THEME_ACCENT, type BrandTheme } from '@/lib/content-engine/brand-identity'
import { agentStorageSignedUrl } from '@/agent/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function isTheme(v: unknown): v is BrandTheme {
  return typeof v === 'string' && v in THEME_ACCENT
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: {
    storagePath?: string
    hook?: string
    productCode?: string
    productName?: string
    price?: string
    eyebrow?: string
    offer?: string
    mode?: string
    theme?: string
    footer?: boolean
    layout?: unknown
    pendingActionId?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : ''
  if (!storagePath) return Response.json({ error: 'storagePath_required' }, { status: 400 })
  if (storagePath.endsWith('.mp4')) {
    return Response.json({ error: 'video_not_supported', message: 'ভিডিওতে ফিনিশিং করা যায় না, স্যার।' }, { status: 400 })
  }

  const hook = (typeof body.hook === 'string' ? body.hook : '').trim()
  if (!hook) return Response.json({ error: 'hook_required', message: 'একটা hook লেখা লাগবে।' }, { status: 400 })

  const mode =
    body.mode === 'product_card' ? 'product_card'
    : body.mode === 'lifestyle' ? 'lifestyle'
    : 'model_overlay'
  const theme: BrandTheme = isTheme(body.theme) ? body.theme : 'default'

  let framedPath: string
  try {
    framedPath = await applyBrandFrame(storagePath, {
      mode,
      // For 'lifestyle' the hook is the headline; eyebrow/offer are the other two
      // editable lines (blank → brand defaults). The same hook drives other modes.
      hook: hook.slice(0, mode === 'lifestyle' ? 80 : 64),
      productCode: typeof body.productCode === 'string' ? body.productCode.slice(0, 24) : undefined,
      productName: typeof body.productName === 'string' ? body.productName.slice(0, 48) : undefined,
      price: typeof body.price === 'string' ? body.price.slice(0, 24) : undefined,
      eyebrow: typeof body.eyebrow === 'string' ? body.eyebrow.slice(0, 32) : undefined,
      offer: typeof body.offer === 'string' ? body.offer.slice(0, 48) : undefined,
      theme,
      footer: body.footer === true,
      // Editor geometry tweaks (lifestyle only). applyLayoutOverrides clamps every
      // value, so a malformed object can't push text off-canvas — pass through any
      // plain object and let the renderer validate.
      layout:
        mode === 'lifestyle' && body.layout && typeof body.layout === 'object' && !Array.isArray(body.layout)
          ? (body.layout as LifestyleLayoutOverrides)
          : null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: 'finish_failed', message: msg }, { status: 422 })
  }

  // Persist the framed copy back onto the gallery item so it shows the "Branded"
  // toggle and survives a reload (best-effort — never fail the finish for this).
  const pendingActionId = typeof body.pendingActionId === 'string' ? body.pendingActionId.trim() : ''
  if (pendingActionId) {
    try {
      const row = await db.agentPendingAction.findUnique({ where: { id: pendingActionId } })
      if (row) {
        const result = (row.result ?? {}) as Record<string, unknown>
        await db.agentPendingAction.update({
          where: { id: pendingActionId },
          data: { result: { ...result, brandedPath: framedPath } },
        })
      }
    } catch (err) {
      console.warn('[finish] persist brandedPath failed:', err instanceof Error ? err.message : err)
    }
  }

  let framedUrl: string
  try {
    framedUrl = await agentStorageSignedUrl(framedPath, 3600)
  } catch (err) {
    return Response.json({ error: 'sign_failed', message: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }

  return Response.json({ framedPath, framedUrl })
}
