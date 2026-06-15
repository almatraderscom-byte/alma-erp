import { prisma } from '@/lib/prisma'
import { agentStorageCopy } from '@/agent/lib/storage'
import { BRAND } from '@/lib/content-engine/brand-identity'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const STABLE_PATHS = {
  logo: BRAND.logoPath,
  logo_transparent: BRAND.logoTransparentPath,
} as const

const save_brand_asset: AgentTool = {
  name: 'save_brand_asset',
  description:
    'Save a brand asset (logo) the owner uploaded, into brand storage, and record its path for the brand frame. ' +
    'Use when the owner sends the ALMA logo and asks to save it. kind: "logo" (charcoal bg) or "logo_transparent".',
  input_schema: {
    type: 'object' as const,
    properties: {
      imagePath: {
        type: 'string',
        description: 'storage path of the uploaded image (from the message attachment)',
      },
      kind: { type: 'string', enum: ['logo', 'logo_transparent'] },
    },
    required: ['imagePath', 'kind'],
  },
  handler: async (input) => {
    const imagePath = String(input.imagePath ?? '').trim()
    const kind = String(input.kind ?? '').trim() as keyof typeof STABLE_PATHS
    if (!imagePath || !(kind in STABLE_PATHS)) {
      return { success: false, error: 'imagePath ও kind (logo | logo_transparent) লাগবে।' }
    }
    const stable = STABLE_PATHS[kind]
    try {
      await agentStorageCopy(imagePath, stable)
      await db.brandAsset.upsert({
        where: { kind },
        create: { kind, path: stable },
        update: { path: stable },
      })
      return {
        success: true,
        data: {
          kind,
          path: stable,
          message: `✅ Logo সেভ হয়েছে: ${stable}`,
        },
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Logo সেভ ব্যর্থ।' }
    }
  },
}

export const BRAND_TOOLS: AgentTool[] = [save_brand_asset]

export const BRAND_ROLE_PROMPT = `
## ব্র্যান্ড লোগো
মালিক ALMA লোগো পাঠিয়ে সেভ করতে বললে save_brand_asset ব্যবহার করুন (kind: logo বা logo_transparent)। সেভ করা path নিশ্চিত করে জানান — brand frame প্রতিটি পোস্টে এটি ব্যবহার করে।
`
