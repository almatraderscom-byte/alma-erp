/**
 * Auto-verification helpers for staff tasks (best-effort).
 */
import { getAppUrl, getInternalToken } from '../env.mjs'
const PAGES = [
  { id: '1044848232034171', name: 'Alma Lifestyle', envKey: 'FB_PAGE_TOKEN_LIFESTYLE' },
  { id: '827260860637393', name: 'Alma Online Shop', envKey: 'FB_PAGE_TOKEN_ONLINESHOP' },
]

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

function formatBnTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('bn-BD', {
      timeZone: 'Asia/Dhaka',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function taskKeywords(task) {
  const parts = [task.title, task.detail, task.product_ref].filter(Boolean).join(' ')
  return parts.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
}

async function checkFbPageActivity(task) {
  const keywords = taskKeywords(task)
  for (const page of PAGES) {
    const token = process.env[page.envKey]
    if (!token) continue
    try {
      const url = `https://graph.facebook.com/v21.0/${page.id}/feed?limit=8&fields=message,story,created_time&access_token=${encodeURIComponent(token)}`
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()
      const posts = data.data ?? []
      const cutoff = Date.now() - TWO_HOURS_MS
      for (const post of posts) {
        const created = new Date(post.created_time).getTime()
        if (created < cutoff) continue
        const text = `${post.message ?? ''} ${post.story ?? ''}`.toLowerCase()
        const match = keywords.length === 0 || keywords.some((k) => text.includes(k))
        if (match || posts.indexOf(post) === 0) {
          return {
            verified: true,
            evidence: `✅ ${page.name}-এ নতুন পোস্ট পাওয়া গেছে (${formatBnTime(post.created_time)})`,
            method: 'auto_fb',
            pageId: page.id,
          }
        }
      }
    } catch { /* try next page */ }
  }
  return { verified: false, evidence: 'FB-তে সাম্প্রতিক পোস্ট পাওয়া যায়নি', method: 'manual' }
}

async function checkMessengerActivity(task, supabase) {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    const { data: rows } = await supabase
      .from('staff_reply_stats')
      .select('count, avg_minutes, page_id')
      .eq('staff_id', task.staff_id)
      .eq('date', today)
      .order('count', { ascending: false })
      .limit(3)

    if (rows?.length && rows[0].count > 0) {
      return {
        verified: true,
        evidence: `✅ আজ ${rows[0].count}টি রিপ্লাই রেকর্ড (${rows[0].avg_minutes ?? '?'} মিনিট গড়)`,
        method: 'auto_fb',
      }
    }
  } catch { /* fall through */ }
  return { verified: false, evidence: 'মেসেঞ্জার রিপ্লাই ডেটা পাওয়া যায়নি', method: 'manual' }
}

async function checkErpProductUpdate(task) {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/task-verify-erp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({ action: 'listing', task }),
    })
    const data = await res.json()
    return {
      verified: Boolean(data.verified),
      evidence: data.evidence ?? '',
      method: data.method ?? 'auto_erp',
    }
  } catch (err) {
    return { verified: false, evidence: err.message, method: 'manual' }
  }
}

async function checkErpOrderUpdates(task) {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/task-verify-erp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({ action: 'order', task }),
    })
    const data = await res.json()
    return {
      verified: Boolean(data.verified),
      evidence: data.evidence ?? '',
      method: data.method ?? 'auto_erp',
    }
  } catch (err) {
    return { verified: false, evidence: err.message, method: 'manual' }
  }
}

const CONTENT_TYPES = new Set(['ad_creative', 'product_content', 'product_photo', 'video_reel'])

/**
 * Assess whether submitted proof matches the task.
 * Returns { matches, confidence, note, feedback }. On error, never blocks submission.
 */
export async function assessProofQuality({ task, proofImageUrl, proofText }) {
  const fallback = { matches: true, confidence: 'low', note: '', feedback: null }
  if (!task?.type || !CONTENT_TYPES.has(task.type)) return fallback
  if (!getAppUrl() || !getInternalToken()) return fallback

  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/assess-task-proof`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({
        taskTitle: task.title,
        taskDetail: task.detail ?? '',
        taskType: task.type,
        proofImageUrl: proofImageUrl ?? '',
        proofText: proofText ?? '',
      }),
    })
    const data = await res.json()
    const matches = data.matches !== false
    const confidence = data.confidence === 'high' ? 'high' : 'low'
    const note = typeof data.note === 'string' ? data.note : ''

    // Generate specific feedback for staff improvement
    let feedback = null
    if (!matches && confidence === 'high') {
      feedback = generateSpecificFeedback(task.type, note, task)
    }

    return { matches, confidence, note, feedback }
  } catch {
    return fallback
  }
}

/**
 * Generate specific, actionable feedback instead of generic "quality issue".
 * Tailored to the staff's task type and common failure modes.
 */
function generateSpecificFeedback(taskType, assessmentNote, task) {
  const note = (assessmentNote || '').toLowerCase()
  const hints = []

  if (taskType === 'product_photo') {
    if (note.includes('dark') || note.includes('light') || note.includes('dim')) {
      hints.push('ছবির brightness কম — next time জানালার পাশে তুলবেন')
    }
    if (note.includes('background') || note.includes('messy') || note.includes('clutter')) {
      hints.push('ব্যাকগ্রাউন্ড পরিষ্কার নয় — সাদা কাগজ বা কাপড় use করুন')
    }
    if (note.includes('blur') || note.includes('focus') || note.includes('sharp')) {
      hints.push('ছবি blur — ফোন স্থির রেখে tap-to-focus করুন')
    }
    if (note.includes('angle') || note.includes('view')) {
      hints.push('একটাই angle দেখা যাচ্ছে — সামনে, পেছনে, close-up সব দিক তুলুন')
    }
  }

  if (taskType === 'video_reel') {
    if (note.includes('short') || note.includes('duration') || note.includes('long')) {
      hints.push('ভিডিও length ঠিক নেই — ১৫-৩০ সেকেন্ডের মধ্যে রাখুন')
    }
    if (note.includes('audio') || note.includes('sound') || note.includes('music')) {
      hints.push('Audio/music নেই — CapCut-এ trending sound যোগ করুন')
    }
    if (note.includes('text') || note.includes('caption') || note.includes('price')) {
      hints.push('Text overlay নেই — product name ও price text যোগ করুন')
    }
    if (note.includes('shak') || note.includes('stable') || note.includes('steady')) {
      hints.push('ভিডিও shake হচ্ছে — ফোন স্থির রাখুন বা tripod use করুন')
    }
  }

  if (taskType === 'ad_creative') {
    if (note.includes('cta') || note.includes('action') || note.includes('order')) {
      hints.push('CTA missing — "DM করুন" বা "Order now" clearly যোগ করুন')
    }
    if (note.includes('brand') || note.includes('logo')) {
      hints.push('Brand identity নেই — ALMA logo/watermark যোগ করুন')
    }
    if (note.includes('size') || note.includes('dimension') || note.includes('resolution')) {
      hints.push('Size ঠিক নেই — 1080×1080 (feed) বা 1080×1920 (story) হতে হবে')
    }
    if (note.includes('text') || note.includes('read')) {
      hints.push('Text পড়া যাচ্ছে না — ফন্ট বড় করুন, contrast ভালো রাখুন')
    }
  }

  if (taskType === 'product_content') {
    if (note.includes('hashtag')) {
      hints.push('Hashtag নেই — ৫-৭টি relevant hashtag যোগ করুন')
    }
    if (note.includes('price') || note.includes('দাম')) {
      hints.push('Price mention নেই — দাম অবশ্যই উল্লেখ করুন')
    }
    if (note.includes('cta') || note.includes('order') || note.includes('action')) {
      hints.push('CTA নেই — "অর্ডার করতে DM করুন" type একটা line দিন')
    }
  }

  if (!hints.length) {
    if (note) {
      hints.push(`⚠️ ${assessmentNote}`)
    } else {
      hints.push('প্রমাণ টাস্কের সাথে ঠিক match হচ্ছে না — detail check করুন')
    }
  }

  return {
    taskType,
    hints,
    summary: hints.join('\n'),
  }
}

/**
 * Track which criteria a staff commonly fails on — stored in agent_kv for gradual improvement.
 */
export async function trackProofFailurePattern(supabase, staffId, taskType, failedAspects) {
  if (!supabase || !staffId || !taskType || !failedAspects?.length) return
  try {
    const key = `proof_failures:${staffId}`
    const { data: existing } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle()

    const record = (existing?.value && typeof existing.value === 'object') ? existing.value : {}
    if (!record[taskType]) record[taskType] = {}

    for (const aspect of failedAspects) {
      record[taskType][aspect] = (record[taskType][aspect] ?? 0) + 1
    }

    await supabase.from('agent_kv_settings').upsert({
      key,
      value: record,
      updated_at: new Date().toISOString(),
    })
  } catch { /* non-critical */ }
}

/**
 * Get staff's common failure patterns for personalized task briefing.
 */
export async function getStaffWeaknesses(supabase, staffId) {
  try {
    const key = `proof_failures:${staffId}`
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle()

    if (!data?.value || typeof data.value !== 'object') return {}
    return data.value
  } catch {
    return {}
  }
}

export async function autoVerifyTask(task, supabase) {
  switch (task.type) {
    case 'page_management':
    case 'ad_creative':
    case 'product_content':
    case 'product_photo':
    case 'video_reel':
      return checkFbPageActivity(task)

    case 'customer_reply':
      return checkMessengerActivity(task, supabase)

    case 'listing_update':
      return checkErpProductUpdate(task)

    case 'order_followup':
      return checkErpOrderUpdates(task)

    default:
      return { verified: false, evidence: 'ম্যানুয়াল প্রমাণ দরকার', method: 'manual' }
  }
}
