/** Friendly display for each tool while it runs in the "checking" UI. */
export const TOOL_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  confirm_oxylabs_spend: { label: 'Oxylabs খরচ অনুমোদন চাইছি', icon: '🔍', color: '#f59e0b' },
  web_research: { label: 'ওয়েব রিসার্চ করছি', icon: '🌐', color: '#3b82f6' },
  get_fb_messenger_inbox: { label: 'Messenger ইনবক্স দেখছি', icon: '💬', color: '#0084ff' },
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
}

export function toolDisplay(name: string) {
  return TOOL_LABELS[name] ?? { label: 'চেক করছি', icon: '🔧', color: '#71717a' }
}
