/**
 * Phase 52 — data classification for tool inputs/outputs.
 *
 * Every executable tool carries a data class so the guard kernel can apply
 * least-privilege and leak rules per the constitution (rule 11: minimize
 * personal/customer/staff data; secrets never enter model context or proofs).
 *
 * Classes are ordered by sensitivity; the guard treats anything above
 * 'business_internal' as leak-guarded when crossing an external surface.
 */

export const DATA_CLASSES = ['public', 'business_internal', 'personal', 'staff_pii', 'customer_pii', 'credentials'] as const
export type DataClass = (typeof DATA_CLASSES)[number]

const SENSITIVITY: Record<DataClass, number> = {
  public: 0,
  business_internal: 1,
  personal: 2,
  staff_pii: 3,
  customer_pii: 3,
  credentials: 4,
}

export function isMoreSensitive(a: DataClass, b: DataClass): boolean {
  return SENSITIVITY[a] > SENSITIVITY[b]
}

/**
 * Default data class per capability domain. Per-tool overrides below win.
 * Domains not listed default to 'business_internal' (the safe middle: never
 * treated as freely publishable, never blocks internal work).
 */
const DOMAIN_DATA_CLASS: Record<string, DataClass> = {
  // public-safe surfaces
  website: 'public',
  seo: 'public',
  research: 'public',
  competitor: 'public',
  analytics: 'business_internal',
  marketing: 'business_internal',
  ads: 'business_internal',
  growth: 'business_internal',
  creative: 'business_internal',
  studio: 'business_internal',
  tryon: 'business_internal',
  brand: 'business_internal',
  content: 'business_internal',
  gbp: 'business_internal',
  campaign: 'customer_pii', // audience lists / send targets
  // business core
  erp: 'business_internal',
  trading: 'business_internal',
  approvals: 'business_internal',
  plan: 'business_internal',
  workbench: 'business_internal',
  skills: 'business_internal',
  artifacts: 'business_internal',
  simulate: 'business_internal',
  diag: 'business_internal',
  qc: 'business_internal',
  vision: 'business_internal',
  playbook: 'business_internal',
  reference: 'business_internal',
  worktodo: 'business_internal',
  orchestrator: 'business_internal',
  autonomy: 'business_internal',
  cost: 'business_internal',
  settings: 'business_internal',
  coworker: 'business_internal',
  browser: 'business_internal',
  live_browser: 'business_internal',
  push: 'business_internal',
  alerts: 'business_internal',
  core: 'business_internal',
  tasking: 'business_internal',
  // people data
  staff: 'staff_pii',
  location: 'staff_pii',
  camera: 'staff_pii',
  cs: 'customer_pii',
  social: 'customer_pii',
  wa: 'customer_pii',
  calls: 'customer_pii',
  // owner-personal
  memory: 'personal',
  personal: 'personal',
  finance: 'personal',
  bills: 'personal',
  dates: 'personal',
  appointments: 'personal',
  health: 'personal',
  documents: 'personal',
  family: 'personal',
  salah: 'personal',
  reminders: 'personal',
  briefing: 'personal',
  todo: 'personal',
  ask: 'personal',
}

/** Per-tool overrides where a tool's data is more sensitive than its domain. */
const TOOL_DATA_CLASS: Record<string, DataClass> = {
  live_browser_pair: 'credentials', // pairing codes gate the owner's own Chrome
  set_api_credit: 'business_internal',
  extract_invoice: 'business_internal',
  get_staff_location: 'staff_pii',
  get_staff_location_history: 'staff_pii',
}

export function dataClassFor(toolName: string, domain: string): DataClass {
  return TOOL_DATA_CLASS[toolName] ?? DOMAIN_DATA_CLASS[domain] ?? 'business_internal'
}

// ── Output leak tripwires (deterministic, cheap, no model calls) ─────────────

/**
 * Secret-shaped substrings that must never leave through a tool result destined
 * for an external surface (customer/staff message, public post, webhook).
 * Phase 55 adds the full DLP module; this is the guard-kernel floor.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/, // OpenAI/Anthropic-style keys
  /AIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /(?:^|[^A-Za-z0-9])(?:xox[bpars]-[A-Za-z0-9-]{10,})/, // Slack tokens
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, // JWTs
  /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/, // DB connection strings with creds
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /whsec_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/, // AWS access key ids
]

export interface LeakScanResult {
  clean: boolean
  matches: string[]
}

/** Scan an outbound payload for secret-shaped content. Deterministic. */
export function scanForSecretLeaks(payload: unknown): LeakScanResult {
  let blob: string
  try {
    blob = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    return { clean: false, matches: ['unserializable_payload'] }
  }
  const matches: string[] = []
  for (const re of SECRET_PATTERNS) {
    if (re.test(blob)) matches.push(re.source.slice(0, 32))
  }
  return { clean: matches.length === 0, matches }
}
