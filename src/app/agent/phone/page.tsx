import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
import SoftphonePanel from '@/agent/components/phone/SoftphonePanel'

/**
 * The browser phone. Any logged-in staff member can take and place real calls here — the
 * point of self-hosting the PBX: no SIM, no handset, no per-seat fee, and the call lands in
 * the same place as the order data it is about.
 */

export const metadata = { title: 'ALMA Agent — ফোন' }

export default async function PhonePage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  // Deliberately open to all staff, not owner-only: taking customer calls is their job.

  return (
    <div className="h-full overflow-y-auto">
      <AgentSubHeader
        title="ব্রাউজার"
        accent="ফোন"
        subtitle="সিম ছাড়াই কল ধরুন • কলদাতার তথ্য পর্দায় • সহকর্মীকে ফ্রি কল"
      />
      <div className="mx-auto max-w-2xl px-4 pt-4 pb-10">
        <SoftphonePanel />
        <div className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-sm text-white/55">
          <p>• &ldquo;ফোন চালু করো&rdquo; চাপলে ব্রাউজার মাইক্রোফোনের অনুমতি চাইবে — একবার দিলেই হবে।</p>
          <p>• কল এলে কলদাতার নাম, কত অর্ডার, বাকি কত আর আগে কতবার কল করেছেন — সব পর্দায় দেখাবে।</p>
          <p>• সহকর্মীকে কল করতে তার ৪ ডিজিটের এক্সটেনশন, কাস্টমারকে করতে 01… নম্বর লিখুন।</p>
          <p>• ট্যাব বন্ধ থাকলে কল আসবে না — কল ধরতে চাইলে পাতাটা খোলা রাখুন।</p>
        </div>
      </div>
    </div>
  )
}
