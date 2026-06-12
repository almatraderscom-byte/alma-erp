#!/usr/bin/env node
/**
 * One-off: fix legacy outbound_call rows marked failed despite ok+callSid,
 * and append dial result messages to conversations.
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

function buildDialMessage(phone, callSid) {
  return (
    `✅ স্যার, কল দেওয়া হয়েছে — ${phone}।\n\n` +
    `লাইনে রিং চলছে; কেউ ধরলে বা না ধরলে আলাদা মেসেজ পাবেন।` +
    (callSid ? `\n(Ref: ${callSid.slice(0, 12)}…)` : '')
  )
}

const rows = await p.agentPendingAction.findMany({
  where: { type: 'outbound_call', status: 'failed' },
  orderBy: { createdAt: 'desc' },
  take: 20,
})

let healed = 0
for (const row of rows) {
  const result = row.result
  if (!result?.ok || !result?.callSid) continue

  await p.agentPendingAction.update({
    where: { id: row.id },
    data: { status: 'executed' },
  })

  const convId = row.conversationId
  const phone = String(row.payload?.phone ?? '')
  if (convId) {
    const text = buildDialMessage(phone, result.callSid)
    const existing = await p.agentMessage.findFirst({
      where: {
        conversationId: convId,
        role: 'assistant',
        content: { path: ['0', 'text'], string_contains: 'কল দেওয়া হয়েছে' },
      },
    })
    if (!existing) {
      await p.agentMessage.create({
        data: {
          conversationId: convId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        },
      })
      await p.agentConversation.update({
        where: { id: convId },
        data: { updatedAt: new Date() },
      })
    }
  }
  console.log('healed', row.id, phone, result.callSid)
  healed++
}

console.log(`✅ healed ${healed} outbound_call row(s)`)
await p.$disconnect()
