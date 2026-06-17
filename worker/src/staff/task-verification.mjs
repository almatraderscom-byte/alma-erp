/**
 * Task verification orchestration — Done flow, proof, owner review cards.
 */
import { getAppUrl, getInternalToken } from '../env.mjs'
import { autoVerifyTask, assessProofQuality, trackProofFailurePattern } from './verify-task.mjs'
import { taskDoneCallbackData, compactUuid, buildCallbackData } from '../telegram/callback-data.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { notifyStaffTaskProgress, resolveTaskProgressContext } from './task-progress.mjs'

import { getOwnerChatId } from '../telegram/owner-id.mjs'
import { uploadTaskProofPhoto } from './task-proof-storage.mjs'
import { loggedSendToStaff } from '../telegram/logged-send.mjs'

/** staffChatId → taskId */
export const awaitingProof = new Map()

/** taskId currently being processed — prevents duplicate owner cards */
const proofInFlight = new Set()

/** ownerChatId → taskId (awaiting redo note) */
export const awaitingRedoNote = new Map()

const CONTENT_TYPES = new Set([
  'ad_creative', 'product_content', 'product_photo', 'video_reel', 'organic_marketing',
])
const QC_TYPES = CONTENT_TYPES
const AUTO_FIRST_TYPES = new Set([
  'page_management', 'customer_reply', 'listing_update', 'order_followup',
])
const TEXT_PROOF_TYPES = new Set(['order_followup'])

const PROOF_REQUEST_MSG = '📸 ভাই, কাজের একটা screenshot/ছবি পাঠান — verify করে দিচ্ছি।'

async function callTaskCallback(payload) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/task-callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function runTaskAutoQc(task, proofImageUrl) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/task-auto-qc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify({
      taskType: task.type,
      taskTitle: task.title,
      proofImageUrl,
    }),
    signal: AbortSignal.timeout(35_000),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function notifyOwnerBrief(telegram, staffName, taskTitle) {
  const ownerId = getOwnerChatId()
  if (!ownerId) return
  await telegram.sendMessage(ownerId, `✅ ${staffName}: "${taskTitle}" — verify হয়েছে।`).catch((err) => {
    console.warn('[task-verification] owner brief notify failed:', err.message)
  })
}

async function escalateQcToOwner(telegram, task, staff, { reason, score, imageUrl, redoCount }) {
  const ownerId = getOwnerChatId()
  if (!ownerId) return
  const scoreLine = score != null ? ` (score: ${score}/100)` : ''
  let body =
    `⚠️ *QC Escalation* — ${staff.name}\n\n` +
    `📋 ${task.title}\n` +
    `🔁 ${redoCount} বার redo — pass হয়নি।\n` +
    `কারণ: ${reason}${scoreLine}\n\n` +
    `_Approve করবেন নাকি আবার করতে বলবেন?_`
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: verifyApproveCb(task.id) },
      { text: '🔄 আবার করো', callback_data: verifyRedoCb(task.id) },
    ]],
  }
  if (imageUrl) {
    await telegram.sendPhoto(ownerId, imageUrl, {
      caption: body.slice(0, 1024),
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }).catch(async () => {
      await sendMarkdownSafe(telegram, ownerId, body, { reply_markup: keyboard })
    })
  } else {
    await sendMarkdownSafe(telegram, ownerId, body, { reply_markup: keyboard })
  }
}

function verifyApproveCb(taskId) {
  return buildCallbackData('task_vfy_ok', compactUuid(taskId))
}

function verifyRedoCb(taskId) {
  return buildCallbackData('task_vfy_redo', compactUuid(taskId))
}

export async function notifyOwnerForReview(telegram, taskRow, result) {
  const ownerId = getOwnerChatId()
  if (!ownerId) return
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
    if (result.proofQuality.feedback?.summary) {
      body += `\n💡 ${result.proofQuality.feedback.summary}`
    } else if (result.proofQuality.note) {
      body += ` (${result.proofQuality.note})`
    }
    body += '\n'
  }

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: verifyApproveCb(result.taskId ?? taskRow.id) },
      { text: '🔄 আবার করো', callback_data: verifyRedoCb(result.taskId ?? taskRow.id) },
    ]],
  }

  if (imageUrl) {
    await telegram.sendPhoto(ownerId, imageUrl, {
      caption: body.slice(0, 1024),
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }).catch(async () => {
      await sendMarkdownSafe(telegram, ownerId, body, { reply_markup: keyboard })
    })
  } else {
    await sendMarkdownSafe(telegram, ownerId, body, { reply_markup: keyboard })
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
    await notifyOwnerBrief(ctx.telegram, result.staffName ?? staff.name, result.taskTitle ?? taskRow?.title ?? 'টাস্ক')
    return { instant: true, result, learning: taskRow?.type === 'learning' }
  }

  const staffChatId = String(ctx.chat?.id ?? staff.telegramChatId ?? '')
  if (staffChatId) awaitingProof.set(staffChatId, taskId)

  const useQcPrompt = QC_TYPES.has(result.taskType ?? taskRow?.type ?? '')
  await ctx.reply(useQcPrompt ? PROOF_REQUEST_MSG : (result.staffMessage ?? PROOF_REQUEST_MSG))

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

/** Rehydrate in-memory proof waiters after worker restart. */
export async function hydrateAwaitingProof(supabase) {
  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('id, staff_id, agent_staff(telegramChatId)')
    .eq('status', 'awaiting_proof')
    .eq('verification_status', 'awaiting_proof')
    .limit(50)

  let count = 0
  for (const task of tasks ?? []) {
    const chatId = task.agent_staff?.telegramChatId
    if (!chatId) continue
    awaitingProof.set(String(chatId), task.id)
    count++
  }
  if (count) console.log(`[task-verification] hydrated ${count} awaiting_proof session(s)`)
  return count
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
    .select('id, title, detail, type, status, verification_status, redo_count')
    .eq('id', taskId)
    .eq('staff_id', staff.id)
    .maybeSingle()

  const vStatus = task?.verification_status ?? task?.verificationStatus
  const allowedV = vStatus === 'awaiting_proof' || vStatus === 'redo_requested'
  if (!task || task.status !== 'awaiting_proof' || !allowedV) {
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
      const res = await fetch(fileLink.href ?? fileLink, { signal: AbortSignal.timeout(30_000) })
      const buf = Buffer.from(await res.arrayBuffer())
      const imageUrl = await storeProofPhoto(supabase, taskId, buf)
      proofType = 'screenshot'
      proofData = { imageUrl, fileId: best.file_id, receivedAt: new Date().toISOString() }
    } else if (text?.trim()) {
      proofType = 'text'
      proofData = { text: text.trim().slice(0, 2000) }
    } else {
      return true
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

    const redoCount = task.redo_count ?? 0
    const needsQc = QC_TYPES.has(task.type) && proofData.imageUrl

    if (needsQc) {
      let qc = null
      try {
        qc = await runTaskAutoQc(task, proofData.imageUrl)
      } catch (err) {
        console.warn('[task-verification] auto-qc call failed:', err.message)
      }

      if (qc?.ran && !qc.shadowMode) {
        if (qc.passed) {
          await callTaskCallback({
            taskId,
            action: 'qc_pass',
            proofType,
            proofData: { ...proofData, autoQcScore: qc.score, autoQcVerdict: qc.verdict },
          })
          await ctx.reply('✅ verify হয়েছে — ভালো কাজ!')
          await notifyOwnerBrief(ctx.telegram, staff.name, task.title)
          return true
        }

        const fixReason = qc.reason || 'ছবি/কনটেন্ট আরেকটু ঠিক করতে হবে।'
        if (redoCount < 2) {
          await callTaskCallback({
            taskId,
            staffId: staff.id,
            action: 'qc_redo',
            reviewerNote: fixReason,
            proofData: { autoQcScore: qc.score, autoQcIssues: qc.issues },
          })
          awaitingProof.set(chatId, taskId)
          await ctx.reply(`🔁 ভাই, একটু ঠিক করতে হবে: ${fixReason}\nআবার screenshot পাঠান।`)
          return true
        }

        await ctx.reply('⚠️ ২ বার চেষ্টা হয়েছে — Boss-কে জানানো হয়েছে।')
        await escalateQcToOwner(ctx.telegram, task, staff, {
          reason: fixReason,
          score: qc.score,
          imageUrl: proofData.imageUrl,
          redoCount,
        })
        return true
      }

      if (qc?.ran && qc.shadowMode) {
        console.log(`[task-verification] auto-qc shadow: task=${taskId} score=${qc.score} passed=${qc.passed}`)
      }
    }

    let proofQuality = null
    if (CONTENT_TYPES.has(task.type) && !needsQc) {
      proofQuality = await assessProofQuality({
        task,
        proofImageUrl: proofData.imageUrl,
        proofText: proofData.text,
      })
      if (proofQuality && !proofQuality.matches && proofQuality.confidence === 'high') {
        const failedAspects = proofQuality.feedback?.hints ?? [proofQuality.note].filter(Boolean)
        await trackProofFailurePattern(supabase, staff.id, task.type, failedAspects).catch(() => {})
      }
    }

    if (proofQuality && !proofQuality.matches && proofQuality.confidence === 'high' && proofQuality.feedback?.hints?.length) {
      const feedbackMsg = `📝 প্রমাণ পেয়েছি। কিছু বিষয় next time মনে রাখবেন:\n${proofQuality.feedback.hints.slice(0, 3).join('\n')}`
      await ctx.reply(feedbackMsg)
    } else if (!needsQc || !QC_TYPES.has(task.type)) {
      await ctx.reply('✅ প্রমাণ পেয়েছি — Boss যাচাই করবেন।')
    } else {
      await ctx.reply('✅ প্রমাণ পেয়েছি — QC shadow mode, Boss যাচাই করবেন।')
    }
    await notifyOwnerForReview(ctx.telegram, task, { ...result, proofQuality })
    return true
  } finally {
    proofInFlight.delete(taskId)
  }
}

export async function finalizeOwnerApprove(ctx, supabase, taskId) {
  const progressCtx = await resolveTaskProgressContext(supabase, taskId)
  const ownerChatId = String(ctx.chat?.id ?? getOwnerChatId() ?? '')
  const result = await callTaskCallback({ taskId, action: 'approve', ownerChatId })
  await ctx.answerCbQuery('✅ অনুমোদিত')
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})

  const dateYmd = result.proposedFor ?? progressCtx.dateYmd
  const staffId = result.staffId ?? progressCtx.staffId
  const staffName = result.staffName ?? progressCtx.staffName
  const ownerId = getOwnerChatId()

  if (ownerId && staffName) {
    await notifyStaffTaskProgress(ctx.telegram, supabase, ownerId, {
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
  const ownerChatId = String(ctx.chat?.id ?? getOwnerChatId() ?? '')
  const result = await callTaskCallback({
    taskId,
    action: 'redo',
    reviewerNote: note,
    ownerChatId,
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
      requiresAck: true,
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
    requiresAck: true,
    extra: { reply_markup: keyboard },
  }).catch(() => telegram.sendMessage(staffChatId, msg, { reply_markup: keyboard }))
}
