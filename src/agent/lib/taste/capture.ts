/**
 * Capture owner keep/reject taste signals from content/ad creatives.
 */
import { prisma } from '@/lib/prisma'
import { agentStorageDownload } from '@/agent/lib/storage'
import { describeCreativeTaste } from '@/agent/lib/taste/vision'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type TasteVerdict = 'keep' | 'reject'

export async function captureTasteSignal(args: {
  verdict: TasteVerdict
  imagePath: string
  productCode?: string | null
  productType?: string | null
  source: string
}): Promise<{ id: string } | null> {
  if (!args.imagePath?.trim()) return null

  try {
    const buf = await agentStorageDownload(args.imagePath)
    const mime = args.imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const attrs = await describeCreativeTaste(buf.toString('base64'), mime)

    const row = await db.agentTasteSignal.create({
      data: {
        verdict: args.verdict,
        attrs,
        productCode: args.productCode ?? null,
        productType: args.productType ?? null,
        imagePath: args.imagePath,
        source: args.source,
      },
    })
    return { id: row.id as string }
  } catch (err) {
    console.error('[taste-capture] failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Fire-and-forget wrapper for hooks. */
export function captureTasteSignalAsync(args: Parameters<typeof captureTasteSignal>[0]): void {
  void captureTasteSignal(args).catch(() => {})
}
