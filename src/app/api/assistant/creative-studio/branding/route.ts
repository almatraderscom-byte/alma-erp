/**
 * GET  /api/assistant/creative-studio/branding  → current branding config (+ signed logo url)
 * POST /api/assistant/creative-studio/branding   → multipart { config: JSON, logo?: File }
 *
 * The owner manages logo + product-code + hook overlay settings here. The logo
 * is auto-resized server-side (so any upload size is fine — owner can't get it
 * wrong) and stored in agent-files; the JSON config lives in the `cs_branding`
 * kv setting the VPS worker reads when stamping branded variants.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 30

const KV_KEY = 'cs_branding'
const LOGO_PATH = 'branding/logo.png'
const LOGO_MAX_DIM = 600 // normalize logos to ≤600px on the long edge
const LOGO_MAX_BYTES = 5 * 1024 * 1024

const PLACEMENTS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left', 'bottom-center'])

type BrandingConfig = {
  enabled: boolean
  logoPath: string | null
  placement: string
  logoWidthPct: number
  marginPct: number
  showCode: boolean
  showHook: boolean
  defaultHook: string
  codePrefix: string
  textColor: string
}

const DEFAULTS: BrandingConfig = {
  enabled: false,
  logoPath: null,
  placement: 'bottom-right',
  logoWidthPct: 16,
  marginPct: 4,
  showCode: true,
  showHook: true,
  defaultHook: '',
  codePrefix: 'Code: ',
  textColor: '#FFFFFF',
}

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

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function sanitizeColor(c: unknown): string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim()) ? c.trim() : DEFAULTS.textColor
}

async function readConfig(): Promise<BrandingConfig> {
  const row = await db.agentKvSetting.findUnique({ where: { key: KV_KEY } })
  if (!row?.value) return { ...DEFAULTS }
  try {
    const parsed = JSON.parse(row.value)
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  const config = await readConfig()
  let logoUrl: string | null = null
  if (config.logoPath) {
    try {
      logoUrl = await agentStorageSignedUrl(config.logoPath, 3600)
    } catch {
      logoUrl = null
    }
  }
  return Response.json({ ...config, logoUrl })
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

  const current = await readConfig()
  let incoming: Partial<BrandingConfig> = {}
  const rawConfig = form.get('config')
  if (typeof rawConfig === 'string') {
    try {
      incoming = JSON.parse(rawConfig)
    } catch {
      return Response.json({ error: 'invalid_config_json' }, { status: 400 })
    }
  }

  let logoPath = current.logoPath
  const logo = form.get('logo')
  if (logo && typeof logo !== 'string') {
    const file = logo as File
    if (file.size > LOGO_MAX_BYTES) {
      return Response.json({ error: 'logo_too_large', message: 'লোগো ৫MB এর কম হতে হবে।' }, { status: 400 })
    }
    try {
      const sharp = (await import('sharp')).default
      const input = Buffer.from(await file.arrayBuffer())
      // Auto-resize to a safe size, keep transparency (PNG). Owner can't pick a
      // wrong size — we always normalize to ≤600px on the long edge.
      const normalized = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize({ width: LOGO_MAX_DIM, height: LOGO_MAX_DIM, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
      await agentStorageUpload(LOGO_PATH, normalized, 'image/png', { upsert: true })
      logoPath = LOGO_PATH
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: 'logo_process_failed', message: msg }, { status: 422 })
    }
  }

  const next: BrandingConfig = {
    enabled: incoming.enabled ?? current.enabled,
    logoPath,
    placement: PLACEMENTS.has(String(incoming.placement)) ? String(incoming.placement) : current.placement,
    logoWidthPct: clampNum(incoming.logoWidthPct, 5, 40, current.logoWidthPct),
    marginPct: clampNum(incoming.marginPct, 1, 15, current.marginPct),
    showCode: incoming.showCode ?? current.showCode,
    showHook: incoming.showHook ?? current.showHook,
    defaultHook: typeof incoming.defaultHook === 'string' ? incoming.defaultHook.slice(0, 80) : current.defaultHook,
    codePrefix: typeof incoming.codePrefix === 'string' ? incoming.codePrefix.slice(0, 24) : current.codePrefix,
    textColor: incoming.textColor !== undefined ? sanitizeColor(incoming.textColor) : current.textColor,
  }

  await db.agentKvSetting.upsert({
    where: { key: KV_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: KV_KEY, value: JSON.stringify(next) },
  })

  let logoUrl: string | null = null
  if (next.logoPath) {
    try {
      logoUrl = await agentStorageSignedUrl(next.logoPath, 3600)
    } catch {
      logoUrl = null
    }
  }
  return Response.json({ ...next, logoUrl })
}
