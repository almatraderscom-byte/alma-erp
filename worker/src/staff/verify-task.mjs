/**
 * Auto-verification helpers for staff tasks (best-effort).
 */
const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

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
    const res = await fetch(`${APP_URL}/api/assistant/internal/task-verify-erp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INT_TOKEN}`,
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
    const res = await fetch(`${APP_URL}/api/assistant/internal/task-verify-erp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INT_TOKEN}`,
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
