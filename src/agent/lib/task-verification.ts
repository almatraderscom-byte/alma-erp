/**
 * Staff task verification — settings, task-type proof rules, status helpers.
 */
import { prisma } from '@/lib/prisma'

export const KV_VERIFICATION_ENABLED = 'task_verification_enabled'
export const KV_SKIP_TYPES = 'task_verification_skip_types'

export type VerificationStatus =
  | 'not_required'
  | 'awaiting_proof'
  | 'proof_submitted'
  | 'auto_verified'
  | 'owner_approved'
  | 'redo_requested'

export type ProofType = 'photo' | 'screenshot' | 'link' | 'auto_fb' | 'auto_erp' | 'none' | 'text'

const CONTENT_TYPES = new Set([
  'ad_creative', 'product_content', 'product_photo', 'video_reel',
])

const FB_PAGE_TYPES = new Set(['page_management', 'customer_reply'])

const ERP_AUTO_TYPES = new Set(['listing_update', 'order_followup'])

const GENERIC_PROOF_TYPES = new Set(['office_task', 'content_support', 'stock_check'])

export async function isTaskVerificationEnabled(): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: KV_VERIFICATION_ENABLED } })
  if (!row?.value) return true
  return row.value !== 'false' && row.value !== '0'
}

export async function getVerificationSkipTypes(): Promise<string[]> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: KV_SKIP_TYPES } })
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export async function shouldVerifyTaskType(taskType: string): Promise<boolean> {
  const enabled = await isTaskVerificationEnabled()
  if (!enabled) return false
  const skip = await getVerificationSkipTypes()
  return !skip.includes(taskType)
}

export function proofPromptForType(taskType: string): {
  mode: 'photo' | 'text' | 'auto_then_fallback'
  message: string
} {
  if (CONTENT_TYPES.has(taskType)) {
    return { mode: 'photo', message: 'কাজের ফটো/স্ক্রিনশট পাঠান 📸' }
  }
  if (FB_PAGE_TYPES.has(taskType)) {
    return { mode: 'auto_then_fallback', message: '✅ চেক করা হচ্ছে...' }
  }
  if (taskType === 'listing_update') {
    return { mode: 'auto_then_fallback', message: '✅ ERP চেক করা হচ্ছে...' }
  }
  if (taskType === 'order_followup') {
    return { mode: 'auto_then_fallback', message: '✅ অর্ডার চেক করা হচ্ছে...' }
  }
  if (GENERIC_PROOF_TYPES.has(taskType)) {
    return { mode: 'photo', message: 'কাজের প্রমাণ পাঠান — ফটো বা স্ক্রিনশট 📸' }
  }
  return { mode: 'photo', message: 'কাজের প্রমাণ পাঠান 📸' }
}

export function isPendingReview(task: {
  status?: string | null
  verificationStatus?: string | null
}): boolean {
  if (task.status === 'awaiting_proof') return true
  const vs = task.verificationStatus
  return vs === 'awaiting_proof'
    || vs === 'proof_submitted'
    || vs === 'auto_verified'
}

export function isEffectivelyDone(task: { status?: string | null }): boolean {
  return task.status === 'done'
}

export function todayDisplayIcon(task: {
  status?: string | null
  verificationStatus?: string | null
}): string {
  if (task.verificationStatus === 'redo_requested' || task.status === 'sent' && task.verificationStatus === 'redo_requested') {
    return '🔄'
  }
  if (isPendingReview(task)) return '🔍'
  if (task.status === 'done') return '✅'
  if (task.status === 'done_unverified') return '⚠️'
  return '⏳'
}

export function extractProductRef(task: { productRef?: string | null; title?: string | null }): string | null {
  if (task.productRef?.trim()) return task.productRef.trim()
  const m = String(task.title ?? '').match(/\b(FM|ALM|CODE)?-?(\d{2,4}[A-Z0-9-]*)\b/i)
  return m ? m[0].replace(/^CODE-?/i, '').toUpperCase() : null
}
