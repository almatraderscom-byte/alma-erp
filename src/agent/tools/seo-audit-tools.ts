/**
 * Client-SEO audit tools — crawl + audit ANY public website end-to-end, like an
 * SEO expert (owner request 2026-07-05). Engine runs on the VPS
 * (worker/src/seo/audit.mjs); these tools queue the job and read the result.
 *
 *   • run_website_seo_audit   — queue a full-site crawl+audit for a URL.
 *   • check_website_seo_audit — poll status + score + report/artifact links.
 *
 * The audit is READ-ONLY (polite crawl, SSRF-guarded, submits nothing) so it
 * runs without an approval card. Applying FIXES to a site — content, technical,
 * or anything needing a login — is a SEPARATE owner-gated step (see the
 * client_seo skill pack): the agent proposes, the owner approves/does the
 * critical parts himself.
 */
import { prisma } from '@/lib/prisma'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import { buildClientReportMarkdown, buildCompareMarkdown, buildIssuesCsv, type AuditJson } from '@/agent/lib/seo-report'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// SHORT stable owner link to a private artifact (302→fresh signed URL on click,
// owner login required). The head must copy links verbatim into its reply — a
// 300-char signed JWT once got corrupted in transit (one mistyped char = dead
// link), so we never hand it long URLs.
const ownerFileUrl = (path: string) => {
  const base = (process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
  return `${base}/api/assistant/files?path=${encodeURIComponent(path)}&redirect=1`
}

const run_website_seo_audit: AgentTool = {
  name: 'run_website_seo_audit',
  description:
    'Run a FULL end-to-end SEO audit of ANY public website (own site OR a customer\'s site) — a world-class ' +
    'SEO-expert-grade crawl. It politely crawls the site (same-origin, read-only, no form submits), and ' +
    'checks per-page (title, meta description, H1, canonical, noindex, viewport, lang, Open Graph, ' +
    'structured data / schema.org, image alt, thin content, mixed content) AND site-wide (https + http→https ' +
    'redirect, robots.txt, sitemap.xml, duplicate titles/descriptions, broken internal links, TTFB/speed, ' +
    'compression). Returns a 0-100 score + a severity-ranked issue list + a Bangla report artifact.\n' +
    'USE for "ei website ta SEO er jonno fully audit koro" / competitor or client site research. Pass the ' +
    'site `url` (https homepage) and optional `maxPages` (default 40, max 80). Then poll check_website_seo_audit.\n' +
    'This is READ-ONLY and safe — no owner approval needed to AUDIT. Applying fixes is a separate, ' +
    'owner-gated step.\n' +
    'If the site\'s content concerns you (e.g. haram/adult elements), you may NOT refuse or cancel on ' +
    'your own — many kinds of clients come to this business and that decision belongs to the OWNER: ' +
    'state what you saw and ask him (ask_user); if he approves — or he already asked for/approved this ' +
    'audit — do the full job professionally and deliver the complete report.',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'The site homepage (http(s)), e.g. "https://customer-shop.com".' },
      maxPages: { type: 'number', description: 'How many pages to crawl (default 40, max 80).' },
      keywordsNote: {
        type: 'string',
        description: 'Optional: a short note of target keywords / ranking findings to fold into the report.',
      },
    },
    required: ['url'],
  },
  handler: async (input) => {
    try {
      const url = String(input.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) {
        return { success: false, error: 'url must start with http(s)://' }
      }
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null
      const maxPages = Math.min(Math.max(Number(input.maxPages) || 40, 5), 80)

      const action = await db.agentPendingAction.create({
        data: {
          conversationId,
          type: 'seo_audit',
          payload: { url, maxPages, keywordsNote: input.keywordsNote ?? null, conversationId },
          summary: `🔎 SEO audit: ${url} (${maxPages} pages)`,
          costEstimate: 0,
          // Read-only crawl, no owner-side effects → runs without an approval card.
          status: 'approved',
        },
        select: { id: true },
      })
      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          note: `SEO audit queued for ${url}. Poll check_website_seo_audit; a failure leaves a resume checkpoint automatically.`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const check_website_seo_audit: AgentTool = {
  name: 'check_website_seo_audit',
  description:
    'Check a website SEO audit started with run_website_seo_audit: status (approved=crawling, ' +
    'executed=done, failed), the 0-100 score, issue counts by severity, pages crawled, and the storage ' +
    'paths of the report (report.md) + full findings (audit.json).\n' +
    'To READ the FULL report, call this tool again with read:"report" — it returns the whole ' +
    'CLIENT-GRADE Bangla report (executive summary, scorecard, every issue WITH evidence + fix, page ' +
    'inventory, action plan). This is the ONLY way; the storage paths are private — a workbench ' +
    'curl/cat can NEVER fetch them, do not try. Call with read:"links" to get STABLE download links the ' +
    'owner can hand a client: the report (.md), the raw findings (.json) and an Excel-openable issues ' +
    'CSV (with evidence + fix columns) — include these as markdown links in your reply.\n' +
    'read:"compare" builds the BEFORE/AFTER proof report: it diffs this audit against the PREVIOUS ' +
    'audit of the SAME site (score change, resolved issues with evidence, new issues, remaining) and ' +
    'returns the markdown + a stable download link. Use it after client fixes are done and a fresh ' +
    're-audit has executed — this is the proof file the owner sends the client.\n' +
    'After status=executed you MUST put the report content (score, every critical/high issue, ' +
    'prioritized fixes) AND the download links INTO THE SAME REPLY — saying "রিপোর্ট উপরে দিয়েছি" or ' +
    '"done" WITHOUT the content in that reply is forbidden. Never claim the audit is done before ' +
    'status=executed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pendingActionId: {
        type: 'string',
        description:
          'The id from run_website_seo_audit. If you no longer have it (e.g. a new turn), omit it — ' +
          'the tool returns the LATEST audit for this conversation automatically.',
      },
      read: {
        type: 'string',
        enum: ['report', 'json', 'links', 'compare'],
        description:
          'Optional: "report" = the FULL client-grade Bangla report text; "json" = the raw audit.json ' +
          'findings; "links" = stable download links (report.md + audit.json + issues.csv for ' +
          'Excel) to hand the owner; "compare" = before/after proof report vs the previous audit of ' +
          'the same site. Use "report" then "links" once status=executed, before replying.',
      },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null
      const rawId = String(input.pendingActionId ?? '').trim()
      // A real UUID id — anything else (empty, "last", a hallucinated value) falls
      // through to the latest-audit lookup so the head can ALWAYS fetch the result
      // without perfectly remembering the id across a yield.
      const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(rawId)

      const actionSelect = { id: true, type: true, status: true, summary: true, result: true, payload: true, createdAt: true }
      let action = looksLikeId
        ? await db.agentPendingAction.findUnique({ where: { id: rawId }, select: actionSelect })
        : null

      // Fallback: the most recent seo_audit (scoped to this conversation when known).
      if (!action || action.type !== 'seo_audit') {
        action = await db.agentPendingAction.findFirst({
          where: { type: 'seo_audit', ...(conversationId ? { conversationId } : {}) },
          orderBy: { createdAt: 'desc' },
          select: actionSelect,
        })
      }

      if (!action || action.type !== 'seo_audit') {
        return { success: false, error: 'কোনো SEO audit পাওয়া যায়নি — আগে run_website_seo_audit চালাও।' }
      }

      // read:"report"|"json"|"links"|"compare" → the artifacts live in PRIVATE
      // storage; only this tool can reach them (workbench included cannot).
      // report/links REGENERATE the client-grade document from audit.json here on
      // Vercel — report quality no longer depends on what the VPS worker wrote.
      let artifactText: string | null = null
      let links: Record<string, string> | null = null
      let compare: Record<string, string> | null = null
      const read = ['report', 'json', 'links', 'compare'].includes(String(input.read)) ? String(input.read) : null

      const artifactsOf = (a: { result: unknown }) => (((a.result as Record<string, unknown> | null)?.artifacts ?? []) as string[])
      const loadAuditJson = async (a: { result: unknown }): Promise<{ path: string; audit: AuditJson } | null> => {
        const p = artifactsOf(a).find((x) => x.endsWith('audit.json'))
        if (!p) return null
        return { path: p, audit: JSON.parse((await agentStorageDownload(p)).toString('utf8')) as AuditJson }
      }
      const keywordsNote = ((action.payload as Record<string, unknown> | null)?.keywordsNote ?? null) as string | null
      const cap = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}\n…[truncated ${text.length - n} chars]` : text)

      if (read && action.status !== 'executed') {
        return { success: false, error: `Audit এখনো ${action.status} — status "executed" হওয়ার পর read:"${read}" দিয়ে ডাকো।` }
      }

      if (read === 'links') {
        try {
          const loaded = await loadAuditJson(action)
          if (!loaded) return { success: false, error: 'Artifact paths পাওয়া যায়নি result-এ।' }
          const reportPath = artifactsOf(action).find((a) => a.endsWith('report.md')) ?? loaded.path.replace(/audit\.json$/, 'report.md')
          const csvPath = reportPath.replace(/report\.md$/, 'issues.csv')
          // Regenerate the client-grade report + evidence CSV from the raw findings
          // (upsert: replaces the worker's bare version and any stale copy).
          await agentStorageUpload(reportPath, Buffer.from(buildClientReportMarkdown(loaded.audit, { keywordsNote }), 'utf8'), 'text/markdown', { upsert: true })
          await agentStorageUpload(csvPath, Buffer.from(buildIssuesCsv(loaded.audit), 'utf8'), 'text/csv', { upsert: true })
          links = {
            reportUrl: ownerFileUrl(reportPath),
            auditJsonUrl: ownerFileUrl(loaded.path),
            issuesCsvUrl: ownerFileUrl(csvPath),
            note: 'লিংকগুলো স্থায়ী — বস তার লগইন-করা ব্রাউজারে ক্লিক করলেই ফাইল নামবে। URL গুলো অক্ষরে-অক্ষরে হুবহু কপি করে reply-তে markdown link হিসেবে দাও: [পুরো রিপোর্ট (md)](…), [সব issue Excel/CSV](…), [raw findings (json)](…)',
          }
        } catch (err) {
          return { success: false, error: `লিংক বানানো গেল না: ${String(err)}` }
        }
      } else if (read === 'compare') {
        try {
          const loaded = await loadAuditJson(action)
          if (!loaded) return { success: false, error: 'Artifact paths পাওয়া যায়নি result-এ।' }
          const host = new URL(loaded.audit.url).hostname.replace(/^www\./, '')
          // The previous EXECUTED audit of the same site (any conversation) = "before".
          const candidates = await db.agentPendingAction.findMany({
            where: { type: 'seo_audit', status: 'executed', id: { not: action.id }, createdAt: { lt: action.createdAt } },
            orderBy: { createdAt: 'desc' },
            take: 25,
            select: { id: true, result: true, payload: true, createdAt: true },
          })
          let beforeAudit: AuditJson | null = null
          for (const cand of candidates) {
            const candUrl = String((cand.payload as Record<string, unknown> | null)?.url ?? '')
            try {
              if (new URL(candUrl).hostname.replace(/^www\./, '') !== host) continue
            } catch {
              continue
            }
            const candLoaded = await loadAuditJson(cand)
            if (candLoaded) {
              beforeAudit = candLoaded.audit
              break
            }
          }
          if (!beforeAudit) {
            return { success: false, error: `এই সাইটের (${host}) আগের কোনো executed audit পাওয়া যায়নি — আগে-পরে তুলনা করতে দুটো audit লাগে।` }
          }
          const md = buildCompareMarkdown(beforeAudit, loaded.audit)
          const comparePath = loaded.path.replace(/audit\.json$/, 'before-after.md')
          await agentStorageUpload(comparePath, Buffer.from(md, 'utf8'), 'text/markdown', { upsert: true })
          compare = {
            compareMarkdown: cap(md, 30_000),
            compareUrl: ownerFileUrl(comparePath),
            note: 'এটাই client-কে দেওয়ার আগে-পরে প্রমাণ ফাইল — reply-তে সারাংশ + [আগে-পরে রিপোর্ট](লিংক) দাও (লিংক হুবহু কপি)।',
          }
        } catch (err) {
          return { success: false, error: `তুলনা রিপোর্ট বানানো গেল না: ${String(err)}` }
        }
      } else if (read === 'report') {
        try {
          const loaded = await loadAuditJson(action)
          if (loaded) {
            artifactText = cap(buildClientReportMarkdown(loaded.audit, { keywordsNote }), 60_000)
          } else {
            // Very old audits without audit.json: fall back to the stored report.md.
            const stored = artifactsOf(action).find((a) => a.endsWith('report.md'))
            if (!stored) return { success: false, error: 'Artifact path পাওয়া যায়নি result-এ।' }
            artifactText = cap((await agentStorageDownload(stored)).toString('utf8'), 60_000)
          }
        } catch (err) {
          return { success: false, error: `Artifact পড়া গেল না: ${String(err)}` }
        }
      } else if (read === 'json') {
        try {
          const wanted = artifactsOf(action).find((a) => a.endsWith('audit.json'))
          if (!wanted) return { success: false, error: 'Artifact path পাওয়া যায়নি result-এ।' }
          // audit.json can be big — cap hard so a huge crawl can't blow the context.
          artifactText = cap((await agentStorageDownload(wanted)).toString('utf8'), 40_000)
        } catch (err) {
          return { success: false, error: `Artifact পড়া গেল না: ${String(err)}` }
        }
      }

      return {
        success: true,
        data: {
          id: action.id,
          status: action.status, // approved = still crawling, executed = done, failed = error
          summary: action.summary,
          result: action.result ?? null,
          ...(artifactText != null ? { [read === 'report' ? 'reportMarkdown' : 'auditJson']: artifactText } : {}),
          ...(links ? { downloadLinks: links } : {}),
          ...(compare ? compare : {}),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const SEO_AUDIT_TOOLS: AgentTool[] = [run_website_seo_audit, check_website_seo_audit]
