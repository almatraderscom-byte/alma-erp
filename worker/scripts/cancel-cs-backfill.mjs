#!/usr/bin/env node
/**
 * One-off: dismiss pending shadow drafts + skip pending reply jobs from inbox poll backfill.
 * Run on VPS: node worker/scripts/cancel-cs-backfill.mjs
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const drafts = await p.csShadowDraft.updateMany({
  where: { status: 'pending' },
  data: { status: 'dismissed', escalationStage: 'none' },
})

const jobs = await p.csReplyJob.updateMany({
  where: { status: 'pending' },
  data: { status: 'skipped', lastError: 'backfill_cancelled' },
})

console.log(`Dismissed ${drafts.count} pending draft(s), skipped ${jobs.count} pending job(s)`)
await p.$disconnect()
