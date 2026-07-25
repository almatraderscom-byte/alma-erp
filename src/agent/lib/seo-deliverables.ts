/**
 * Build and file an SEO audit's deliverables the moment the crawl finishes —
 * server-side, without waiting for the model to ask for them.
 *
 * Before this, the client-grade report existed only as a side effect of the
 * head calling `check_website_seo_audit` with read:"report"|"links". If the head
 * never made that call — which is exactly what happened to the owner's deep
 * audit on 2026-07-25 — the only artifact on disk was the worker's bare
 * severity list, and nothing at all was filed into the chat.
 *
 * Now job-result calls `buildSeoDeliverables` on success:
 *   • regenerates the client report (markdown) over the worker's bare version,
 *   • writes the Excel-openable issues CSV,
 *   • writes a self-contained live HTML dashboard,
 *   • files the dashboard as a chat artifact (the file card the owner sees),
 *   • returns a ready Bangla summary the delivery layer can post verbatim.
 *
 * The head's own read:"report" path still works and is now cheap: everything it
 * needs is already built.
 */
import { prisma } from '@/lib/prisma'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import {
  buildClientReportHtml,
  buildClientReportMarkdown,
  buildIssuesCsv,
  type AuditJson,
} from '@/agent/lib/seo-report'
import { ownerFileLink } from '@/agent/lib/job-delivery'
import { saveConversationArtifact } from '@/agent/tools/artifact-tools'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface SeoDeliverables {
  host: string
  score: number
  pagesCrawled: number
  sitemapCount: number
  artifacts: string[]
  summaryBn: string
}

const SEV_LABEL: Record<string, string> = {
  critical: '🔴 জরুরি',
  high: '🟠 গুরুতর',
  medium: '🟡 মাঝারি',
  low: '⚪ ছোট',
}

/** Top issue groups, worst severity first, for the chat summary. */
function topIssueLines(audit: AuditJson, limit = 5): string[] {
  const groups = new Map<string, { severity: string; code: string; detail: string; count: number }>()
  const push = (severity: string, code: string, detail: string) => {
    const k = `${severity}|${code}`
    const prev = groups.get(k)
    groups.set(k, { severity, code, detail, count: (prev?.count ?? 0) + 1 })
  }
  for (const i of audit.siteChecks?.issues ?? []) push(i.severity, i.code, i.detail)
  for (const p of audit.pages ?? []) for (const i of p.issues ?? []) push(i.severity, i.code, i.detail)

  const order = ['critical', 'high', 'medium', 'low']
  return [...groups.values()]
    .sort((a, b) => {
      const s = order.indexOf(a.severity) - order.indexOf(b.severity)
      return s !== 0 ? s : b.count - a.count
    })
    .slice(0, limit)
    .map((g) => `- ${SEV_LABEL[g.severity] ?? g.severity} ${g.detail} — ${g.count}টা জায়গায়`)
}

/**
 * Build every deliverable for a finished audit. Returns null when the action
 * has no audit.json to build from (very old audits, or an upload that failed);
 * callers treat that as "nothing extra to file" and keep going.
 */
export async function buildSeoDeliverables(pendingActionId: string): Promise<SeoDeliverables | null> {
  const action = await db.agentPendingAction.findUnique({
    where: { id: pendingActionId },
    select: { id: true, conversationId: true, result: true, payload: true },
  })
  if (!action) return null

  const result = (action.result ?? {}) as Record<string, unknown>
  const artifacts = Array.isArray(result.artifacts) ? (result.artifacts as string[]) : []
  const jsonPath = artifacts.find((p) => p.endsWith('audit.json'))
  if (!jsonPath) return null

  const audit = JSON.parse((await agentStorageDownload(jsonPath)).toString('utf8')) as AuditJson
  const keywordsNote = ((action.payload as Record<string, unknown> | null)?.keywordsNote ?? null) as string | null

  const reportPath = artifacts.find((p) => p.endsWith('report.md')) ?? jsonPath.replace(/audit\.json$/, 'report.md')
  const csvPath = reportPath.replace(/report\.md$/, 'issues.csv')
  const htmlPath = reportPath.replace(/report\.md$/, 'report.html')

  const reportMd = buildClientReportMarkdown(audit, { keywordsNote })
  const reportHtml = buildClientReportHtml(audit, { keywordsNote })
  await agentStorageUpload(reportPath, Buffer.from(reportMd, 'utf8'), 'text/markdown', { upsert: true })
  await agentStorageUpload(csvPath, Buffer.from(buildIssuesCsv(audit), 'utf8'), 'text/csv', { upsert: true })
  await agentStorageUpload(htmlPath, Buffer.from(reportHtml, 'utf8'), 'text/html', { upsert: true })

  const host = (() => {
    try { return new URL(audit.url).hostname.replace(/^www\./, '') } catch { return audit.url }
  })()

  // The live dashboard is the artifact the owner actually opens; file it as a
  // chat file card so it is already there when the head writes its reply.
  if (action.conversationId) {
    try {
      await saveConversationArtifact({
        conversationId: action.conversationId,
        title: `SEO অডিট ড্যাশবোর্ড — ${host}`,
        content: reportHtml,
        type: 'html',
      })
    } catch (err) {
      console.warn('[seo-deliverables] artifact card failed:', err instanceof Error ? err.message : err)
    }
  }

  const pagesCrawled = audit.pagesCrawled ?? audit.pages?.length ?? 0
  const sitemapCount = audit.sitemap?.count ?? 0
  const coverage = sitemapCount ? `${pagesCrawled}/${sitemapCount} পেজ (sitemap অনুযায়ী)` : `${pagesCrawled} পেজ`
  const c = audit.counts

  const summaryBn = [
    `Boss, **${host}**-এর পূর্ণ SEO অডিট শেষ।`,
    '',
    `**স্কোর: ${audit.score}/100** · দেখা হয়েছে ${coverage}`,
    `সমস্যা: 🔴 ${c.critical} · 🟠 ${c.high} · 🟡 ${c.medium} · ⚪ ${c.low}`,
    '',
    '**সবচেয়ে বড় সমস্যাগুলো:**',
    ...topIssueLines(audit),
    '',
    'বিস্তারিত প্রমাণ, প্রতিটার সমাধান আর অগ্রাধিকার-প্ল্যান ড্যাশবোর্ডে (নিচের ফাইলে) আছে।',
  ].join('\n')

  const allArtifacts = [...new Set([htmlPath, reportPath, csvPath, jsonPath])]
  await db.agentPendingAction.update({
    where: { id: pendingActionId },
    data: {
      result: {
        ...result,
        artifacts: allArtifacts,
        deliverySummaryBn: summaryBn,
        deliveryLinks: {
          dashboardUrl: ownerFileLink(htmlPath),
          reportUrl: ownerFileLink(reportPath),
          issuesCsvUrl: ownerFileLink(csvPath),
          auditJsonUrl: ownerFileLink(jsonPath),
        },
      },
    },
  })

  return { host, score: audit.score, pagesCrawled, sitemapCount, artifacts: allArtifacts, summaryBn }
}
