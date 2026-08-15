import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'

export const metadata = { title: 'ALMA Agent — Media' }
export const dynamic = 'force-dynamic'

 
const db = prisma as any

const STATUS_BN: Record<string, string> = {
  draft: 'খসড়া',
  planned: 'প্ল্যান — অনুমোদনের অপেক্ষায়',
  approved: 'অনুমোদিত',
  rendering_audio: 'রেন্ডার হচ্ছে — অডিও',
  rendering_image: 'রেন্ডার হচ্ছে — ছবি',
  rendering_clip: 'রেন্ডার হচ্ছে — ক্লিপ',
  rendering_final: 'রেন্ডার হচ্ছে — ফাইনাল স্টিচ',
  final: 'সম্পূর্ণ',
  failed: 'ব্যর্থ',
  cancelled: 'বাতিল',
}

/**
 * Media mode gallery — every AI-video project with status, exact spend and a
 * playable final. Lean by design (owner rule: no clutter).
 */
export default async function AgentMediaPage() {
  if (!isAgentEnabled()) notFound()
  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  const projects = await db.agentMediaProject.findMany({
    orderBy: { createdAt: 'desc' },
    take: 40,
  })
  const rows = await Promise.all(
    projects.map(async (p: {
      id: string; title: string; status: string; aspect: string
      totalEstimateUsd: number | null; totalActualUsd: number | null
      finalAssetPath: string | null; createdAt: Date
    }) => ({
      ...p,
      finalUrl: p.finalAssetPath ? await agentStorageSignedUrl(p.finalAssetPath, 3600).catch(() => null) : null,
    })),
  )

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">🎬 Media প্রজেক্ট</h1>
      <p className="text-sm opacity-70 mb-6">
        চ্যাটে আইডিয়া বললেই নতুন ভিডিও — এখানে সব প্রজেক্টের অবস্থা আর ফাইনাল ভিডিও।
      </p>
      {rows.length === 0 && (
        <p className="text-sm opacity-70">এখনো কোনো প্রজেক্ট নেই — agent চ্যাটে গিয়ে একটা ভিডিওর কথা বলুন।</p>
      )}
      <ul className="space-y-4">
        {rows.map((p) => (
          <li key={p.id} className="rounded-2xl border border-black/10 dark:border-white/10 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{p.title}</div>
                <div className="text-xs opacity-70 mt-0.5">
                  {STATUS_BN[p.status] ?? p.status} · {p.aspect} ·{' '}
                  {new Date(p.createdAt).toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' })}
                </div>
              </div>
              <div className="text-right text-xs opacity-80 shrink-0">
                {typeof p.totalEstimateUsd === 'number' && <div>এস্টিমেট ${p.totalEstimateUsd.toFixed(2)}</div>}
                {typeof p.totalActualUsd === 'number' && <div>আসল ${p.totalActualUsd.toFixed(2)}</div>}
              </div>
            </div>
            {p.finalUrl && (
              <video
                controls
                preload="metadata"
                playsInline
                className="mt-3 w-full rounded-xl bg-black"
                src={p.finalUrl}
              />
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}
