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
import { agentStorageDownload } from '@/agent/lib/storage'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

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
    'owner-gated step.',
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
    'To READ the FULL report, call this tool again with read:"report" — it returns the whole Bangla ' +
    'report.md text (this is the ONLY way; the storage paths are private — a workbench curl/cat can ' +
    'NEVER fetch them, do not try). After status=executed you MUST paste the report (or a faithful ' +
    'full summary: score, every critical/high issue, prioritized fixes) INTO YOUR REPLY to the owner — ' +
    'never say "done" without delivering the report content. Never claim the audit is done before ' +
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
        enum: ['report', 'json'],
        description:
          'Optional: also return the FULL artifact content — "report" = the Bangla report.md text, ' +
          '"json" = the raw audit.json findings. Use "report" once status=executed, before replying.',
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

      let action = looksLikeId
        ? await db.agentPendingAction.findUnique({
            where: { id: rawId },
            select: { id: true, type: true, status: true, summary: true, result: true },
          })
        : null

      // Fallback: the most recent seo_audit (scoped to this conversation when known).
      if (!action || action.type !== 'seo_audit') {
        action = await db.agentPendingAction.findFirst({
          where: { type: 'seo_audit', ...(conversationId ? { conversationId } : {}) },
          orderBy: { createdAt: 'desc' },
          select: { id: true, type: true, status: true, summary: true, result: true },
        })
      }

      if (!action || action.type !== 'seo_audit') {
        return { success: false, error: 'কোনো SEO audit পাওয়া যায়নি — আগে run_website_seo_audit চালাও।' }
      }

      // read:"report"|"json" → fetch the full artifact from private storage so the
      // head can deliver the WHOLE report (the 1500-char preview in result is not
      // enough, and nothing else — workbench included — can reach the bucket).
      let artifactText: string | null = null
      const read = input.read === 'report' || input.read === 'json' ? input.read : null
      if (read) {
        if (action.status !== 'executed') {
          return {
            success: false,
            error: `Audit এখনো ${action.status} — status "executed" হওয়ার পর read:"${read}" দিয়ে ডাকো।`,
          }
        }
        const artifacts = ((action.result as Record<string, unknown> | null)?.artifacts ?? []) as string[]
        const wanted = artifacts.find((a) => (read === 'report' ? a.endsWith('report.md') : a.endsWith('audit.json')))
        if (!wanted) return { success: false, error: 'Artifact path পাওয়া যায়নি result-এ।' }
        try {
          const buf = await agentStorageDownload(wanted)
          // report.md is small (tens of KB); audit.json can be bigger — cap both
          // hard so a huge crawl can't blow the context.
          const cap = read === 'report' ? 60_000 : 40_000
          const text = buf.toString('utf8')
          artifactText = text.length > cap ? `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]` : text
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
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const SEO_AUDIT_TOOLS: AgentTool[] = [run_website_seo_audit, check_website_seo_audit]
