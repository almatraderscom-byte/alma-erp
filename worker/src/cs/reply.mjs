/**
 * CS-1 — Process pending customer reply jobs.
 */
import { sendTypingOn, sendMessengerText, sendMessengerImage } from './meta-send.mjs'
import { notifyShadowDraft } from './shadow-notify.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function randomDelay() {
  return 2000 + Math.floor(Math.random() * 2000)
}

export async function processCsReplyJob(job, bot) {
  const { id: jobId, conversationId, messageId, conversation } = job
  const pageId = conversation?.pageId
  const psid = conversation?.psid
  if (!pageId || !psid) throw new Error('missing pageId/psid')

  await sendTypingOn(pageId, psid)
  await sleep(randomDelay())

  const res = await fetch(`${APP_URL()}/api/assistant/internal/cs-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify({ jobId, conversationId, messageId }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `cs-run HTTP ${res.status}`)

  if (data.skipped && !(data.parts?.length)) {
    console.log(`[cs-reply] skipped ${conversationId}: ${data.reason}`)
    return
  }

  if (data.shadowOnly && data.shadowDraftId) {
    await notifyShadowDraft(bot, {
      draftId: data.shadowDraftId,
      pageId,
      psid,
      parts: data.parts ?? [],
    })
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
      await sendMessengerText(pageId, psid, part.text)
      await sleep(800)
    } else if (part.type === 'image' && part.imageUrl) {
      await sendMessengerImage(pageId, psid, part.imageUrl)
      await sleep(800)
    }
  }

  console.log(`[cs-reply] sent ${parts.length} part(s) to ${psid}`)
}

export async function pollCsPendingReplies(bot) {
  const res = await fetch(`${APP_URL()}/api/assistant/internal/cs-pending-replies`, {
    headers: { Authorization: `Bearer ${INT_TOKEN()}` },
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
