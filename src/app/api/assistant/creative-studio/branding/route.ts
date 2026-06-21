/**
 * GET  /api/assistant/creative-studio/branding  → brand status (logo url + themes)
 * POST /api/assistant/creative-studio/branding   → multipart { logo: File, transparent? }
 *
 * The brand identity (colours, fonts, logo) is the single source of truth in
 * brand-identity.ts + the BrandAsset table — applyBrandFrame() uses it for every
 * finished image. Here the owner only manages the LOGO. Product code + hook are
 * NOT global; they're entered per image at finishing time.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import { BRAND, THEME_ACCENT, getLogoPath } from '@/lib/content-engine/brand-identity'

export const runtime = 'nodejs'
export const maxDuration = 30

const LOGO_MAX_DIM = 600 // normalize logos to ≤600px on the long edge
const LOGO_MAX_BYTES = 5 * 1024 * 1024

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

async function brandStatus() {
  // Prefer the transparent logo (what the model overlay uses); fall back to solid.
  let logoUrl: string | null = null
  let hasLogo = false
  for (const transparent of [true, false]) {
    try {
      const row = await db.brandAsset.findUnique({
        where: { kind: transparent ? 'logo_transparent' : 'logo' },
      })
      if (row?.path) {
        logoUrl = await agentStorageSignedUrl(row.path, 3600).catch(() => null)
        hasLogo = true
        if (logoUrl) break
      }
    } catch {
      /* table missing / not configured — fall through */
    }
  }
  return {
    hasLogo,
    logoUrl,
    themes: Object.keys(THEME_ACCENT),
    brandName: BRAND.name,
  }
}

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  return Response.json(await brandStatus())
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return Response.json({ error: 'invalid_form' }, { status: 400 })
  }

  const logo = form.get('logo')
  if (!logo || typeof logo === 'string') {
    return Response.json({ error: 'logo_required' }, { status: 400 })
  }
  const file = logo as File
  if (file.size > LOGO_MAX_BYTES) {
    return Response.json({ error: 'logo_too_large', message: 'লোগো ৫MB এর কম হতে হবে।' }, { status: 400 })
  }

  // transparent (PNG with alpha) is what the model overlay uses; default to it.
  const transparent = String(form.get('transparent') ?? '1') !== '0'
  const kind = transparent ? 'logo_transparent' : 'logo'
  const stablePath = await getLogoPath(transparent) // stable path (BrandAsset or default)
  const targetPath = stablePath || (transparent ? BRAND.logoTransparentPath : BRAND.logoPath)

  try {
    const sharp = (await import('sharp')).default
    const input = Buffer.from(await file.arrayBuffer())
    // Auto-resize so the owner can't pick a wrong size — always ≤600px long edge,
    // keep transparency (PNG).
    const normalized = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({ width: LOGO_MAX_DIM, height: LOGO_MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    await agentStorageUpload(targetPath, normalized, 'image/png', { upsert: true })
    await db.brandAsset.upsert({
      where: { kind },
      create: { kind, path: targetPath },
      update: { path: targetPath },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: 'logo_process_failed', message: msg }, { status: 422 })
  }

  return Response.json(await brandStatus())
}
