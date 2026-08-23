import { getServerSession } from 'next-auth'
import { notFound, redirect } from 'next/navigation'
import AgentMarkdown from '@/agent/components/AgentMarkdown'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'

export const metadata = { title: 'Professional report preview — ALMA Agent' }
export const dynamic = 'force-dynamic'

const REPORT_FIXTURE = `**Bottom line: বর্তমান implementation professional report-এর hierarchy, evidence এবং action plan—তিনটিই পরিষ্কারভাবে দেখাচ্ছে।**

## নির্বাহী সারাংশ

ALMA Agent এখন ছোট উত্তরকে স্বাভাবিক রাখবে, কিন্তু বড় report, audit বা analysis-কে একটি polished executive format-এ সাজাবে। অপ্রয়োজনীয় decoration যোগ হবে না; তথ্যের গুরুত্ব অনুযায়ী heading, list, table ও callout ব্যবহার হবে।

## KPI ও সাপ্তাহিক অবস্থা

| ক্ষেত্র | অবস্থা | যাচাই |
|---|---|---|
| Report structure | সম্পন্ন | Bottom line + meaningful sections |
| Web renderer | সম্পন্ন | Heading, list, table ও callout |
| Native iOS renderer | সম্পন্ন | বাংলা numbering ও task list |

## মূল পর্যবেক্ষণ

1. **Outcome আগে:** সিদ্ধান্ত প্রথমেই দেখা যায়; পাঠককে পুরো report স্ক্যান করতে হয় না।
2. **Evidence আলাদা:** verified fact, inference এবং unavailable data এক জায়গায় মিশে যায় না।
3. **Action স্পষ্ট:** প্রতিটি recommendation ছোট, ranked এবং বাস্তবায়নযোগ্য থাকে।

> **Verification note:** এটি preview-only visual fixture। এখানে কোনো live ERP data নেই এবং screenটি database write করে না।

## আগামী পদক্ষেপ

- [x] Professional response contract সক্রিয়
- [x] Web ও native report hierarchy তৈরি
- [ ] Owner-এর “Go” পাওয়ার পরেই TestFlight শুরু`

export default async function ProfessionalReportPreviewPage() {
  const isPreview = process.env.VERCEL_ENV === 'preview'
  const isLocalDevelopment = process.env.NODE_ENV !== 'production'
  if (!isPreview && !isLocalDevelopment) notFound()

  // Vercel preview deployments are already protected by team SSO. Keep this
  // static, data-free proof route free of application-session/database writes;
  // local development still requires the normal ALMA owner session.
  if (!isPreview) {
    const session = await getServerSession(authOptions)
    if (!session?.user) redirect('/login')
    if (!isSystemOwner(session)) notFound()
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-3xl flex-col px-4 pb-24 pt-8 sm:px-8 sm:pt-12">
      <header className="mb-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#81B29A]">
            Preview fixture · no live data
          </p>
          <h1 className="mt-1 text-xl font-bold tracking-[-0.02em] text-cream">
            Professional agent report
          </h1>
        </div>
        <span className="rounded-full border border-[#81B29A]/25 bg-[#81B29A]/10 px-3 py-1 text-[11px] font-semibold text-[#81B29A]">
          Read-only
        </span>
      </header>

      <article className="overflow-hidden rounded-[24px] border border-border-subtle bg-card/78 shadow-[0_24px_70px_-38px_rgba(0,0,0,0.65)] backdrop-blur-xl">
        <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3.5 sm:px-7">
          <span className="grid size-8 place-items-center rounded-full bg-[#E07A5F]/12 text-sm font-bold text-[#E07A5F]" aria-hidden="true">
            A
          </span>
          <div>
            <p className="text-sm font-semibold text-cream">ALMA Agent</p>
            <p className="text-[11px] text-muted">Professional report renderer</p>
          </div>
        </div>
        <AgentMarkdown content={REPORT_FIXTURE} className="px-5 py-6 sm:px-7 sm:py-8" />
      </article>
    </div>
  )
}
