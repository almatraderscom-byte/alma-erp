/** Detect when owner wants staff task planning (not generic chat). */
export function isStaffTaskStatusInquiry(text: string): boolean {
  const t = text.toLowerCase()
  const hasTask = /task|টাস্ক|কাজ/i.test(t)
  if (!hasTask) return false

  const isCreate =
    /(দাও|দিব|বানাও|প্ল্যান|plan|approve|পাঠাও|dispatch|propose|তৈরি|সেটআপ|assign)/i.test(t)
  if (isCreate) return false

  return (
    /(কি|কী|কোন|কত|list|কি আছে|দেওয়া|দিয়ে|পাঠানো|হয়েছে|হইছে|হয়ে|আছে|করেছে|status|স্ট্যাটাস|দেখাও|বলো|বল|কি দেওয়া)/i.test(t)
    || /(ke|কে).*(task|টাস্ক|কাজ).*(হয়|হই|আছে|দেওয়া|দিয়ে)/i.test(t)
    || /(ajke|আজকে|today).*(task|টাস্ক|কাজ)/i.test(t)
  )
}

/** Detect when owner wants NEW staff task planning / dispatch — not status lookup. */
export function isStaffTaskPlanningInquiry(text: string): boolean {
  if (isStaffTaskStatusInquiry(text)) return false

  const t = text.toLowerCase()
  return (
    (/staff|stuff|স্টাফ|স্টাফ্|কর্মী|টিম/i.test(t) &&
      /task|টাস্ক|কাজ|কাজগুলো|কি হবে|দাও|দিব|প্ল্যান|plan/i.test(t)) ||
    (/eyafi|mustahid|ইয়াফি|মুস্তাহিদ/i.test(t) &&
      /task|টাস্ক|কাজ/i.test(t) &&
      /(দাও|দিব|বানাও|প্ল্যান|plan|approve|পাঠাও)/i.test(t)) ||
    /আজকে.*(কাজ|টাস্ক).*(দাও|দিব|বানাও|প্ল্যান)/i.test(t) ||
    /কাজ.*(দাও|দিব|বানাও|পাঠাও|approve|অ্যাসাইন)/i.test(t) ||
    /টাস্ক.*(প্ল্যান|plan|তৈরি)/i.test(t)
  )
}
