/**
 * Task verification orchestration — Done flow, proof, owner review cards.
 */
import { autoVerifyTask, assessProofQuality } from './verify-task.mjs'
import { taskDoneCallbackData, compactUuid, buildCallbackData } from '../telegram/callback-data.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { notifyStaffTaskProgress, resolveTaskProgressContext } from './task-progress.mjs'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_ID = String(process.env.TELEGRAM_OWNER_CHAT_ID ?? '')
import { uploadTaskProofPhoto } from './task-proof-storage.mjs'
import { loggedSendToStaff } from '../telegram/logged-send.mjs'

/** staffChatId → taskId */
export const awaitingProof = new Map()

/** taskId currently being processed — prevents duplicate owner cards */
const proofInFlight = new Set()

/** ownerChatId → taskId (awaiting redo note) */
export const awaitingRedoNote = new Map()

const CONTENT_TYPES = new Set([
  'ad_creative', 'product_content', 'product_photo', 'video_reel',
])
const AUTO_FIRST_TYPES = new Set([
  'page_management', 'customer_reply', 'listing_update', 'order_followup',
])
const TEXT_PROOF_TYPES = new Set(['order_followup'])

async function callTaskCallback(payload) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/task-callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

function verifyApproveCb(taskId) {
  return buildCallbackData('task_vfy_ok', compactUuid(taskId))
}

function verifyRedoCb(taskId) {
  return buildCallbackData('task_vfy_redo', compactUuid(taskId))
}

export async function notifyOwnerForReview(telegram, taskRow, result) {
  if (!OWNER_ID) return
  if (result.needsOwnerReview === false || result.alreadySubmitted || result.idempotent) return

  const staffName = result.staffName ?? 'স্টাফ'
  const title = result.taskTitle ?? taskRow?.title ?? 'টাস্ক'
  const evidence = result.evidence ?? result.proofData?.evidence ?? ''
  const proofType = result.proofType ?? taskRow?.proof_type
  const imageUrl = result.proofData?.imageUrl ?? taskRow?.proof_data?.imageUrl

  let body =
    `🔍 *টাস্ক যাচাই* — ${staffName}\n\n` +
    `📋 ${title}\n`

  if (evidence && result.verificationStatus === 'auto_verified') {
    body += `🤖 যাচাই: ${evidence}\n`
  } else if (proofType === 'text' && result.proofData?.text) {
    body += `📝 প্রমাণ: ${result.proofData.text}\n`
  } else if (imageUrl) {
    body += `📸 প্রমাণ সংযুক্ত\n`
  } else if (evidence) {
    body += `🤖 ${evidence}\n`
  }

  if (result.proofQuality && !result.proofQuality.matches && result.proofQuality.confidence === 'high') {
    body += `⚠️ প্রমাণ টাস্কের সাথে মিলছে না বলে মনে হচ্ছে।`
    if (result.proofQuality.note) body += ` (${result.proofQuality.note})`
    body += '\n'
  }

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: verifyApproveCb(result.taskId ?? taskRow.id) },
      { text: '🔄 আবার করো', callback_data: verifyRedoCb(result.taskId ?? taskRow.id) },
    ]],
  }

  if (imageUrl) {
    await telegram.sendPhoto(OWNER_ID, imageUrl, {
      caption: body.slice(0, 1024),
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }).catch(async () => {
      await sendMarkdownSafe(telegram, OWNER_ID, body, { reply_markup: keyboard })
    })
  } else {
    await sendMarkdownSafe(telegram, OWNER_ID, body, { reply_markup: keyboard })
  }
}

export async function handleStaffTaskDone(ctx, supabase, taskId, staff) {
  const { data: taskRow } = await supabase
    .from('staff_tasks')
    .select('id, type, title')
    .eq('id', taskId)
    .maybeSingle()

  // Learning tasks are growth-oriented — don't penalize; instant done, no proof pressure
  if (taskRow?.type === 'learning') {
    const result = await callTaskCallback({ taskId, staffId: staff.id, action: 'done' })
    return { instant: true, result, learning: true }
  }

  const result = await callTaskCallback({ taskId, staffId: staff.id, action: 'done' })

  if (result.instant) {
    return { instant: true, result }
  }

  const staffChatId = String(ctx.chat?.id ?? staff.telegramChatId ?? '')
  if (staffChatId) awaitingProof.set(staffChatId, taskId)

  await ctx.reply(result.staffMessage ?? 'কাজের প্রমাণ পাঠান 📸')

  if (AUTO_FIRST_TYPES.has(result.taskType) && !CONTENT_TYPES.has(result.taskType)) {
    const { data: taskRow } = await supabase
      .from('staff_tasks')
      .select('*')
      .eq('id', taskId)
      .single()

    const check = await autoVerifyTask({ ...taskRow, staff_id: staff.id }, supabase)
    if (check.verified) {
      const verified = await callTaskCallback({
        taskId,
        action: 'auto_verified',
        evidence: check.evidence,
        method: check.method,
      })
      awaitingProof.delete(staffChatId)
      await notifyOwnerForReview(ctx.telegram, taskRow, verified)
      return { instant: false, autoVerified: true, result: verified }
    }

    const fallback =
      result.taskType === 'order_followup'
        ? 'অর্ডার ফলোআপের বিস্তারিত টেক্সট পাঠান (অর্ডার নম্বর/স্ট্যাটাস) 📝'
        : 'স্ক্রিনশট পাঠান 📸'
    await ctx.reply(fallback)
  }

  return { instant: false, result }
}

export async function storeProofPhoto(supabase, taskId, fileBuffer, contentType = 'image/jpeg') {
  return uploadTaskProofPhoto(supabase, taskId, fileBuffer, contentType)
}

export async function handleStaffProofMessage(ctx, supabase, staff, { photo, text }) {
  const chatId = String(ctx.chat?.id ?? '')
  const taskId = awaitingProof.get(chatId)
  if (!taskId) return false

  if (proofInFlight.has(taskId)) return true

  const { data: task } = await supabase
    .from('staff_tasks')
    .select('id, title, detail, type, status, verification_status')
    .eq('id', taskId)
    .eq('staff_id', staff.id)
    .maybeSingle()

  const vStatus = task?.verification_status ?? task?.verificationStatus
  if (!task || task.status !== 'awaiting_proof' || vStatus !== 'awaiting_proof') {
    awaitingProof.delete(chatId)
    return vStatus === 'proof_submitted'
  }

  proofInFlight.add(taskId)
  awaitingProof.delete(chatId)

  try {
    let proofType = 'photo'
    let proofData = {}

    if (photo) {
      const best = photo[photo.length - 1]
      const fileLink = await ctx.telegram.getFileLink(best.file_id)
      const res = await fetch(fileLink.href ?? fileLink)
      const buf = Buffer.from(await res.arrayBuffer())
      const imageUrl = await storeProofPhoto(supabase, taskId, buf)
      proofType = 'screenshot'
      proofData = { imageUrl }
    } else if (text?.trim()) {
      proofType = 'text'
      proofData = { text: text.trim().slice(0, 2000) }
    } else {
      return true
    }

    let proofQuality = null
    if (CONTENT_TYPES.has(task.type)) {
      proofQuality = await assessProofQuality({
        task,
        proofImageUrl: proofData.imageUrl,
        proofText: proofData.text,
      })
    }

    const result = await callTaskCallback({
      taskId,
      staffId: staff.id,
      action: 'proof',
      proofType,
      proofData,
    })

    if (result.alreadySubmitted || result.idempotent) {
      return true
    }

    await ctx.reply('✅ প্রমাণ পেয়েছি — Boss যাচাই করবেন।')
    await notifyOwnerForReview(ctx.telegram, task, { ...result, proofQuality })
    return true
  } finally {
    proofInFlight.delete(taskId)
  }
}

export async function finalizeOwnerApprove(ctx, supabase, taskId) {
  const progressCtx = await resolveTaskProgressContext(supabase, taskId)
  const result = await callTaskCallback({ taskId, action: 'approve' })
  await ctx.answerCbQuery('✅ অনুমোদিত')
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})

  const dateYmd = result.proposedFor ?? progressCtx.dateYmd
  const staffId = result.staffId ?? progressCtx.staffId
  const staffName = result.staffName ?? progressCtx.staffName

  if (OWNER_ID && staffName) {
    await notifyStaffTaskProgress(ctx.telegram, supabase, OWNER_ID, {
      staffId,
      staffName,
      dateYmd,
      approvedTaskId: taskId,
      approvedTitle: result.taskTitle ?? progressCtx.task?.title,
    }).catch(() => {})
  }

  return { ...result, staffId, staffName, proposedFor: dateYmd }
}

export async function startOwnerRedo(ctx, taskId) {
  awaitingRedoNote.set(String(ctx.chat?.id), taskId)
  await ctx.answerCbQuery('মন্তব্য লিখুন')
  await ctx.reply('🔄 *আবার করতে বলুন* — ঐচ্ছিক মন্তব্য লিখুন (বা "skip" লিখুন)', { parse_mode: 'Markdown' })
}

export async function applyOwnerRedoNote(ctx, supabase, taskId, note) {
  const result = await callTaskCallback({
    taskId,
    action: 'redo',
    reviewerNote: note,
  })

  const staffChatId = result.staffChatId
  if (staffChatId) {
    const noteLine = result.reviewerNote ? `\nমন্তব্য: ${result.reviewerNote}` : ''
    const msg =
      `🔄 Boss বলেছেন আবার করতে — ${result.taskTitle}।${noteLine}`
    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Done', callback_data: taskDoneCallbackData(taskId) },
      ]],
    }
    await loggedSendToStaff(ctx.telegram, {
      supabase,
      staffId: result.staffId,
      staffName: result.staffName,
      businessId: 'ALMA_LIFESTYLE',
      type: 'task_redo',
      content: msg,
      chatId: staffChatId,
      relatedTaskIds: [taskId],
      extra: { reply_markup: keyboard },
    }).catch(() => ctx.telegram.sendMessage(staffChatId, msg, { reply_markup: keyboard }))
  }

  return result
}

export async function sendRedoToStaff(telegram, supabase, result) {
  const staffChatId = result.staffChatId
  if (!staffChatId) return
  const noteLine = result.reviewerNote ? `\nমন্তব্য: ${result.reviewerNote}` : ''
  const msg =
    `🔄 Boss বলেছেন আবার করতে — ${result.taskTitle}।${noteLine}`
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Done', callback_data: taskDoneCallbackData(result.taskId) },
    ]],
  }
  await loggedSendToStaff(telegram, {
    supabase,
    staffId: result.staffId,
    staffName: result.staffName,
    businessId: 'ALMA_LIFESTYLE',
    type: 'task_redo',
    content: msg,
    chatId: staffChatId,
    relatedTaskIds: [result.taskId],
    extra: { reply_markup: keyboard },
  }).catch(() => telegram.sendMessage(staffChatId, msg, { reply_markup: keyboard }))
}
