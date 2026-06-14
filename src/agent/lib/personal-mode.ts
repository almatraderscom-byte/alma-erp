const PERSONAL_PROJECT_NAMES = new Set(['personal', 'ব্যক্তিগত'])

const WORK_SIGNALS =
  /\b(task|tasks|টাস্ক|staff|স্টাফ|dispatch|অর্ডার|order|sales|বিক্রি|khoroch|খরচ|expense|ads|proposal|product|customer|কাস্টমার|pawna|ledger|inventory|stock|payroll|salary|মেসেঞ্জার|messenger|facebook|fb|campaign)\b/i

const PERSONAL_SIGNALS =
  /\b(আম্মু|মা|বাবা|স্ত্রী|শাশুড়ি|শ্বশুর|ভাই|বোন|পরিবার|সন্তান|ছেলে|মেয়ে|family|wife|mother|father|son|daughter|মন\s*খারাপ|দুঃখ|চিন্তা|একাকী|বিষণ্ণ|stress|worried|sad|lonely|ব্যক্তিগত|personal\s+life|feel\s+down)\b/i

export function isPersonalProjectName(name: string | null | undefined): boolean {
  if (!name?.trim()) return false
  return PERSONAL_PROJECT_NAMES.has(name.trim().toLowerCase())
}

export function stripPersonalCommand(text: string): { text: string; forcePersonal: boolean } {
  const trimmed = text.trim()
  const m = trimmed.match(/^\/personal\b\s*/i)
  if (m) {
    return { text: trimmed.slice(m[0].length).trim() || trimmed, forcePersonal: true }
  }
  if (/^ব্যক্তিগত\b/i.test(trimmed)) {
    return { text: trimmed.replace(/^ব্যক্তিগত\b\s*/i, '').trim() || trimmed, forcePersonal: true }
  }
  return { text: trimmed, forcePersonal: false }
}

export function isImplicitPersonalMessage(text: string): boolean {
  const t = text.trim()
  if (!t || t.length < 4) return false
  if (WORK_SIGNALS.test(t)) return false
  return PERSONAL_SIGNALS.test(t)
}

export function resolvePersonalMode(opts: {
  projectName?: string | null
  forcePersonal?: boolean
  message?: string
}): boolean {
  if (opts.forcePersonal) return true
  if (isPersonalProjectName(opts.projectName)) return true
  if (opts.message && isImplicitPersonalMessage(opts.message)) return true
  return false
}
