/** Friendly display for each tool while it runs in the "checking" UI. */
export const TOOL_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  confirm_oxylabs_spend: { label: 'Oxylabs খরচ অনুমোদন চাইছি', icon: '🔍', color: '#f59e0b' },
  web_research: { label: 'ওয়েব রিসার্চ করছি', icon: '🌐', color: '#3b82f6' },
  get_fb_messenger_inbox: { label: 'Messenger ইনবক্স দেখছি', icon: '💬', color: '#0084ff' },
  get_unanswered_comments: { label: 'রিপ্লাই-বাকি কমেন্ট দেখছি', icon: '💬', color: '#0084ff' },
  reply_to_comment: { label: 'কমেন্ট রিপ্লাই তৈরি করছি', icon: '↩️', color: '#0084ff' },
  get_marketing_history: { label: 'মার্কেটিং হিস্ট্রি দেখছি', icon: '📣', color: '#e1306c' },
  get_marketing_intel: { label: 'মার্কেটিং ইনটেল চেক করছি', icon: '🎯', color: '#e1306c' },
  get_orders: { label: 'ERP অর্ডার চেক করছি', icon: '📦', color: '#16a34a' },
  check_order_issues: { label: 'অর্ডার সমস্যা স্ক্যান করছি', icon: '🔍', color: '#16a34a' },
  get_inventory_status: { label: 'স্টক/ইনভেন্টরি দেখছি', icon: '🏷️', color: '#f59e0b' },
  get_reorder_suggestions: { label: 'রিঅর্ডার দরকার কিনা দেখছি', icon: '🔄', color: '#f59e0b' },
  get_sales_summary: { label: 'সেলস সামারি বিশ্লেষণ করছি', icon: '💰', color: '#22c55e' },
  get_dashboard_snapshot: { label: 'ড্যাশবোর্ড স্ন্যাপশট দেখছি', icon: '📊', color: '#22c55e' },
  search_products: { label: 'প্রোডাক্ট খুঁজছি', icon: '🛍️', color: '#8b5cf6' },
  get_product: { label: 'প্রোডাক্ট ডিটেইল দেখছি', icon: '🛍️', color: '#8b5cf6' },
  get_product_details: { label: 'প্রোডাক্ট ডিটেইল দেখছি', icon: '🛍️', color: '#8b5cf6' },
  recall_business_knowledge: { label: 'যা জানি মনে করছি', icon: '🧠', color: '#06b6d4' },
  search_memory: { label: 'স্মৃতি খুঁজছি', icon: '🧠', color: '#06b6d4' },
  get_customer_segments: { label: 'কাস্টমার সেগমেন্ট দেখছি', icon: '🤝', color: '#06b6d4' },
  get_customer_intelligence: { label: 'কাস্টমার ইন্টেল দেখছি', icon: '🤝', color: '#06b6d4' },
  get_financial_health: { label: 'আর্থিক অবস্থা দেখছি', icon: '🧮', color: '#10b981' },
  analyze_returns: { label: 'রিটার্ন বিশ্লেষণ করছি', icon: '↩️', color: '#f97316' },
  analyze_pricing: { label: 'প্রাইসিং দেখছি', icon: '💲', color: '#f97316' },
  get_attendance: { label: 'অ্যাটেনড্যান্স দেখছি', icon: '📋', color: '#6366f1' },
  get_staff_tasks: { label: 'স্টাফ টাস্ক দেখছি', icon: '✅', color: '#6366f1' },
  prepare_staff_task_proposal: { label: 'টাস্ক প্রপোজাল বানাচ্ছি', icon: '📝', color: '#6366f1' },
  propose_staff_tasks: { label: 'টাস্ক প্রস্তাব সেভ করছি', icon: '📝', color: '#6366f1' },
  generate_owner_briefing: { label: 'ব্রিফিং ডেটা সংগ্রহ করছি', icon: '☀️', color: '#eab308' },
  get_salah_status: { label: 'নামাজের স্ট্যাটাস দেখছি', icon: '🕌', color: '#0ea5e9' },
  delegate_to_specialist: { label: 'সাব-এজেন্টকে কাজ দিচ্ছি', icon: '🤝', color: '#0ea5e9' },
  publish_to_instagram: { label: 'Instagram পোস্ট তৈরি করছি', icon: '📸', color: '#e1306c' },
  send_whatsapp: { label: 'WhatsApp মেসেজ পাঠাচ্ছি', icon: '💬', color: '#25D366' },
  get_wa_inbox: { label: 'WhatsApp ইনবক্স দেখছি', icon: '💬', color: '#25D366' },
  whatsapp_call: { label: 'WhatsApp-এ কল করছি', icon: '📞', color: '#25D366' },
  launch_campaign: { label: 'নতুন ক্যাম্পেইন তৈরি করছি', icon: '🚀', color: '#e1306c' },
  list_audiences: { label: 'Audience তালিকা দেখছি', icon: '🎯', color: '#e1306c' },
  create_retargeting_audience: { label: 'রিটার্গেটিং audience বানাচ্ছি', icon: '🎯', color: '#e1306c' },
  create_lookalike_audience: { label: 'Lookalike audience বানাচ্ছি', icon: '👥', color: '#e1306c' },
}

/**
 * For tools not in the explicit map, derive a readable label from the tool name
 * itself (e.g. `get_warehouse_stock` → "warehouse stock দেখছি") so the owner
 * sees WHAT is being checked — never a bare generic "চেক করছি".
 */
function humanizeToolName(name: string): string {
  const cleaned = name
    .replace(/^(get|fetch|list|load|read|check|scan|search|find|analyze|analyse|review|prepare|propose|generate|create|update|build|run)_/i, '')
    .replace(/_/g, ' ')
    .trim()
  if (!cleaned) return 'চেক করছি'
  return `${cleaned} দেখছি`
}

export function toolDisplay(name: string) {
  const mapped = TOOL_LABELS[name]
  if (mapped) return mapped
  return { label: humanizeToolName(name), icon: '🔧', color: '#71717a' }
}

function truncate(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Build a compact, safe preview of a tool's RESULT for the expandable "Result"
 * card (Claude-app style: click a tool to see what it returned). We never dump an
 * unbounded payload into the stream — the JSON is pretty-printed and hard-capped
 * so a huge query result can't bloat the SSE turn or the message row. `result` is
 * the `{ success, data?, error? }` shape every tool executor returns.
 */
export function toolResultPreview(result: unknown, maxChars = 2000): string | undefined {
  if (result == null) return undefined
  let payload: unknown = result
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    // Prefer the meaningful body: data on success, error message on failure.
    if ('data' in r && r.data !== undefined) payload = r.data
    else if ('error' in r && r.error) payload = r.error
    else payload = r
  }
  let text: string
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  } catch {
    text = String(payload)
  }
  if (!text || !text.trim()) return undefined
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (আরও ${text.length - maxChars} অক্ষর কাটা হয়েছে)`
  return text
}

/**
 * A short, safe "target" pulled from a tool's input so chips read like Claude —
 * e.g. searching "winter jackets", order #1234. Returns null when there's
 * nothing meaningful/short to show. Never dumps the full input.
 */
export function toolDetail(name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const preferred = [
    'query', 'q', 'search', 'keyword', 'name', 'title', 'productName', 'product',
    'orderId', 'orderNumber', 'invoiceId', 'sku', 'phone', 'customer', 'customerName',
    'category', 'segment', 'month', 'date', 'period', 'status', 'role', 'task', 'id',
  ]
  const fmt = (k: string, v: string | number) => {
    const s = String(v).trim()
    if (!s) return null
    if (/order|invoice/i.test(k) || k === 'id') return `#${truncate(s, 16)}`
    return truncate(s)
  }
  for (const k of preferred) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return fmt(k, v)
    if (typeof v === 'number') return fmt(k, v)
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) return fmt(k, v)
    if (typeof v === 'number') return fmt(k, v)
  }
  return null
}
