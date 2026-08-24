import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261020000000_agent_artifact_delivery_outbox/migration.sql',
)
const CRON_ROUTE = path.join(process.cwd(), 'src/app/api/assistant/internal/open-task-nudge/route.ts')
const JOB_DELIVERY = path.join(process.cwd(), 'src/agent/lib/job-delivery.ts')

describe('SEO artifact outbox expand migration', () => {
  it('is additive and backfills executed audit obligations idempotently', async () => {
    const sql = await fs.readFile(MIGRATION, 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "delivery_key"')
    expect(sql).toContain('FROM "agent_pending_actions" action')
    expect(sql).toContain("action.\"type\" = 'seo_audit'")
    expect(sql).toContain("action.\"status\" = 'executed'")
    expect(sql).toContain("action.\"payload\"->>'conversationId'")
    expect(sql).toContain('JOIN "agent_conversations" conversation')
    expect(sql).toMatch(/COALESCE\([\s\S]*action\."conversationId"[\s\S]*action\."payload"->>'conversationId'/)
    expect(sql).toContain('LIMIT 500')
    expect(sql).toContain("eligible.\"id\" = '2617c17a-079f-4f6b-b49e-060e23f4380a'")
    expect(sql).toContain("outbox.\"spec\"->>'backfilled' = 'true'")
    expect(sql).toContain('ON CONFLICT DO NOTHING')
    expect(sql).not.toMatch(/^\s*(?:DELETE|DROP|TRUNCATE)\b/im)
  })
})

describe('SEO artifact cron ownership', () => {
  it('runs one bounded deadline-aware artifact pass through the generic delivery sweep', async () => {
    const [route, delivery] = await Promise.all([
      fs.readFile(CRON_ROUTE, 'utf8'),
      fs.readFile(JOB_DELIVERY, 'utf8'),
    ])
    expect(route).not.toContain('runSeoArtifactDeliverySweep')
    expect(route).toContain('runJobDeliverySweep({ deadlineAt: deliveryDeadlineAt })')
    expect(delivery).toContain('runSeoArtifactDeliverySweep(2')
    expect(delivery).toContain('deadlineAt: options.deadlineAt')
  })
})
