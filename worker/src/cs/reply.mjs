/**
 * CS-1 — Process pending customer reply jobs.
 */
import { sendTypingOn, sendMessengerText, sendMessengerImage } from './meta-send.mjs'
import { sendWaText } from '../wa/wa-send.mjs'
import { notifyShadowDraft } from './shadow-notify.mjs'
import { resilientFetch } from '../fetch-retry.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

const PAGE_NAMES = {
  '1044848232034171': 'Alma Lifestyle',
  '827260860637393': 'Alma Online Shop',
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function randomDelay() {
  return 2000 + Math.floor(Math.random() * 2000)
}

function isWaChannel(pageId) {
  return String(pageId ?? '').startsWith('wa:')
}

export async function processCsReplyJob(job, bot) {
  const { id: jobId, conversationId, messageId, conversation } = job
  const pageId = conversation?.pageId
  const psid = conversation?.psid
  if (!pageId || !psid) throw new Error('missing pageId/psid')

  if (!isWaChannel(pageId)) {
    await sendTypingOn(pageId, psid)
  }
  await sleep(randomDelay())

  const res = await resilientFetch(`${APP_URL()}/api/assistant/internal/cs-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify({ jobId, conversationId, messageId }),
    timeoutMs: 60_000,
    retries: 1,
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `cs-run HTTP ${res.status}`)

  if (data.skipped && !(data.parts?.length)) {
    console.log(`[cs-reply] skipped ${conversationId}: ${data.reason}`)
    return
  }

  if (data.shadowOnly && data.shadowDraftId) {
    if (!bot) {
      console.warn(`[cs-reply] shadow draft ${data.shadowDraftId} — bot unavailable, notification skipped`)
    } else {
      await notifyShadowDraft(bot, {
        draftId: data.shadowDraftId,
        pageId,
        psid,
        parts: data.parts ?? [],
        customerName: conversation?.customerName ?? null,
        pageName: PAGE_NAMES[pageId] ?? null,
      })
    }
    console.log(`[cs-reply] shadow draft ${data.shadowDraftId} for ${conversationId}`)
    return
  }

  if (data.handedOff) {
    console.log(`[cs-reply] handed off ${conversationId}`)
    return
  }

  const parts = data.parts ?? []
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      if (isWaChannel(pageId)) {
        await sendWaText(pageId, psid, part.text)
      } else {
        await sendMessengerText(pageId, psid, part.text)
      }
      await sleep(800)
    } else if (part.type === 'image' && part.imageUrl) {
      if (isWaChannel(pageId)) {
        // Image send via WA media upload not in phase-1 — send link as text fallback.
        await sendWaText(pageId, psid, part.imageUrl)
      } else {
        await sendMessengerImage(pageId, psid, part.imageUrl)
      }
      await sleep(800)
    }
  }

  console.log(`[cs-reply] sent ${parts.length} part(s) to ${psid}`)
}

export async function pollCsPendingReplies(bot) {
  const res = await resilientFetch(`${APP_URL()}/api/assistant/internal/cs-pending-replies`, {
    headers: { Authorization: `Bearer ${INT_TOKEN()}` },
    timeoutMs: 15_000,
    retries: 1,
  })
  if (!res.ok) {
    console.error(`[cs-reply] poll failed HTTP ${res.status}`)
    return
  }
  const { jobs } = await res.json()
  for (const job of jobs ?? []) {
    try {
      await processCsReplyJob(job, bot)
    } catch (err) {
      console.error(`[cs-reply] job ${job.id} error:`, err.message)
    }
  }
}
