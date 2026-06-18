/**
 * Owner "Control Center" switches for the whole agent.
 *
 * Stored as one JSON blob in the existing `AgentKvSetting` table (key
 * `agent_controls`) — no migration needed. Every read FAILS OPEN: if the store
 * is unreachable or malformed, the agent behaves normally (never silently
 * bricked by a settings glitch). Only an explicit owner change alters behavior.
 */
import { prisma } from '@/lib/prisma'

export const AGENT_CONTROLS_KV_KEY = 'agent_controls'

/** ask = approve before acting · notify = act then tell · auto = act on its own
 *  (money + public posts still always ask — enforced by confirm-tools gates). */
export type AutonomyMode = 'ask' | 'notify' | 'auto'

export interface AgentCapabilities {
  webResearch: boolean
  socialPosting: boolean
  imageVideoGen: boolean
}

export interface AgentControls {
  /** Master pause — stops the agent from replying/acting (web + Telegram). */
  paused: boolean
  autonomy: AutonomyMode
  capabilities: AgentCapabilities
}

export const DEFAULT_AGENT_CONTROLS: AgentControls = {
  paused: false,
  autonomy: 'ask',
  capabilities: { webResearch: true, socialPosting: true, imageVideoGen: true },
}

/** Owner-facing capability → the tool names it gates. Names verified against the
 *  tool registry (research/ads/content tools). */
export const CAPABILITY_DEFS: Array<{
  key: keyof AgentCapabilities
  label: string
  tools: string[]
}> = [
  {
    key: 'webResearch',
    label: 'ওয়েব রিসার্চ (Oxylabs)',
    tools: ['web_research', 'confirm_oxylabs_spend', 'research_competitor', 'manage_competitor_watchlist'],
  },
  {
    key: 'socialPosting',
    label: 'সোশ্যাল/ফেসবুক পোস্ট ও অ্যাড',
    tools: ['post_to_facebook', 'run_content_post', 'pause_campaign', 'update_campaign_budget', 'duplicate_campaign', 'recommend_ad_actions'],
  },
  {
    key: 'imageVideoGen',
    label: 'ছবি ও ভিডিও জেনারেশন',
    tools: ['generate_image', 'make_ad_creatives', 'make_product_reel', 'generate_on_model_image', 'generate_on_model_batch'],
  },
]

const AUTONOMY_MODES: AutonomyMode[] = ['ask', 'notify', 'auto']

export function parseAgentControls(value: string | null | undefined): AgentControls {
  if (!value) return structuredClone(DEFAULT_AGENT_CONTROLS)
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return structuredClone(DEFAULT_AGENT_CONTROLS)
    }
    const p = parsed as Partial<AgentControls> & { capabilities?: Partial<AgentCapabilities> }
    return {
      paused: p.paused === true,
      autonomy: AUTONOMY_MODES.includes(p.autonomy as AutonomyMode) ? (p.autonomy as AutonomyMode) : 'ask',
      capabilities: {
        webResearch: p.capabilities?.webResearch !== false,
        socialPosting: p.capabilities?.socialPosting !== false,
        imageVideoGen: p.capabilities?.imageVideoGen !== false,
      },
    }
  } catch {
    return structuredClone(DEFAULT_AGENT_CONTROLS)
  }
}

export async function getAgentControls(): Promise<AgentControls> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: AGENT_CONTROLS_KV_KEY } })
    return parseAgentControls(row?.value)
  } catch {
    // Fail open — a storage hiccup must never block the live agent.
    return structuredClone(DEFAULT_AGENT_CONTROLS)
  }
}

export async function setAgentControls(patch: Partial<AgentControls>): Promise<AgentControls> {
  const current = await getAgentControls()
  const next: AgentControls = {
    ...current,
    ...patch,
    capabilities: { ...current.capabilities, ...(patch.capabilities ?? {}) },
  }
  await prisma.agentKvSetting.upsert({
    where: { key: AGENT_CONTROLS_KV_KEY },
    create: { key: AGENT_CONTROLS_KV_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}

export async function isAgentPaused(): Promise<boolean> {
  return (await getAgentControls()).paused === true
}

/** Tool names the owner has switched OFF (to remove from a turn's toolset). */
export function disabledToolNames(controls: AgentControls): Set<string> {
  const out = new Set<string>()
  for (const def of CAPABILITY_DEFS) {
    if (controls.capabilities[def.key] === false) {
      for (const t of def.tools) out.add(t)
    }
  }
  return out
}

/** Remove disabled-capability tools from an assembled tool list (by name). */
export function filterToolDefsByControls<T extends { name: string }>(
  tools: T[],
  controls: AgentControls,
): T[] {
  const off = disabledToolNames(controls)
  if (off.size === 0) return tools
  return tools.filter((t) => !off.has(t.name))
}

/**
 * A system-prompt note (Bangla) telling the agent which capabilities are OFF —
 * so it stops and asks the owner to enable, instead of burning tokens on
 * workarounds — plus the autonomy preference. Returns null when nothing to say.
 */
export function controlsPromptNote(controls: AgentControls): string | null {
  const parts: string[] = []

  const offDefs = CAPABILITY_DEFS.filter((d) => controls.capabilities[d.key] === false)
  if (offDefs.length > 0) {
    parts.push(
      '## মালিকের বন্ধ করা ফিচার (OFF)\n'
      + 'নিচের ফিচারগুলো মালিক Control Center থেকে বন্ধ করে রেখেছেন, তাই এগুলোর টুল তোমার কাছে নেই:\n'
      + offDefs.map((d) => `- ${d.label}`).join('\n') + '\n'
      + 'এই ধরনের কাজ চাইলে: অন্য উপায়ে চেষ্টা করো না, নিজে অনুমান করে বানিয়ে দিও না। '
      + 'সংক্ষেপে মালিককে জানাও যে ফিচারটি এখন বন্ধ আছে এবং Staff Monitor → Control Center থেকে চালু করতে অনুরোধ করো। '
      + 'চালু করলে স্বাভাবিকভাবে কাজটি সম্পন্ন করো।',
    )
  }

  const autonomyText: Record<AutonomyMode, string> = {
    ask: 'মালিকের সেটিং: "আগে জিজ্ঞেস করো"। কোনো পরিবর্তনমূলক কাজের আগে অনুমতি নাও।',
    notify: 'মালিকের সেটিং: "করে জানাও"। কম-ঝুঁকির কাজ নিজে করে মালিককে জানাও।',
    auto: 'মালিকের সেটিং: "সম্পূর্ণ স্বয়ংক্রিয়"। কম-ঝুঁকির কাজ নিজে করো। তবে টাকা খরচ বা পাবলিক পোস্ট (Facebook/বিজ্ঞাপন) — সবসময় আগে অনুমতি নাও।',
  }
  parts.push('## অটোনমি\n' + autonomyText[controls.autonomy])

  return parts.length ? parts.join('\n\n') : null
}
