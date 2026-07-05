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
    'paths of the report (report.md) + full findings (audit.json). Read the report before summarizing to ' +
    'the owner. Never claim the audit is done before status=executed.',
  input_schema: {
    type: 'object' as const,
    properties: { pendingActionId: { type: 'string' } },
    required: ['pendingActionId'],
  },
  handler: async (input) => {
    try {
      const action = await db.agentPendingAction.findUnique({
        where: { id: String(input.pendingActionId ?? '') },
        select: { id: true, type: true, status: true, summary: true, result: true },
      })
      if (!action || action.type !== 'seo_audit') {
        return { success: false, error: 'SEO audit not found' }
      }
      return {
        success: true,
        data: { id: action.id, status: action.status, summary: action.summary, result: action.result ?? null },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const SEO_AUDIT_TOOLS: AgentTool[] = [run_website_seo_audit, check_website_seo_audit]
