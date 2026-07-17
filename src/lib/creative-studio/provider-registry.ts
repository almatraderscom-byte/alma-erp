/**
 * CS5 — typed provider registry for Creative Studio engines.
 *
 * Single source of truth separating engine IDENTITY (id + fal endpoint),
 * CAPABILITY (which studio modes, single-person-only or not), COMMERCIAL
 * status (production / commercial / research-only) and UI labels. The legacy
 * `StudioProvider` ('fashn' | 'gemini') values used across run payloads and
 * gallery rows keep working through the compatibility mapping below.
 *
 * CS5 ships the registry as FOUNDATION only: the Fal engines are declared but
 * `runnable: false`, so nothing new appears as a runnable choice in the Run UI
 * until CS6 (VTON) / CS7 (FLUX Fill) wire them end to end.
 */
import type { StudioModeId, StudioProvider } from './constants'

export type StudioEngineId =
  | 'fashn' // direct FASHN API (existing production path)
  | 'gemini' // Gemini image (existing draft/fallback path)
  | 'fal_fashn_v16' // fal-ai/fashn/tryon/v1.6 — commercial Fal try-on
  | 'fal_idm_vton' // fal-ai/cat-vton — IDM-VTON-style, research-only
  | 'fal_flux_fill' // fal-ai/flux-pro/v1/fill — masked precision edit

export type EngineCommercialStatus = 'production' | 'commercial' | 'research_only'

export type EngineEnvKey = 'FASHN_API_KEY' | 'GEMINI_API_KEY' | 'FAL_KEY'

/** Owner-tunable kv flags (agent_kv_settings) that gate the Fal engines. */
export const CS_FAL_ENABLED_KEY = 'cs_fal_enabled'
export const CS_IDM_VTON_ENABLED_KEY = 'cs_idm_vton_enabled'
export const CS_FLUX_FILL_ENABLED_KEY = 'cs_flux_fill_enabled'
export const CS_SINGLE_VTON_DEFAULT_KEY = 'cs_single_vton_default'

export type EngineSettingsFlag =
  | typeof CS_FAL_ENABLED_KEY
  | typeof CS_IDM_VTON_ENABLED_KEY
  | typeof CS_FLUX_FILL_ENABLED_KEY

export type StudioEngine = {
  id: StudioEngineId
  label: string
  labelBn: string
  /** upstream vendor bucket for cost attribution ('fashn' | 'google' | 'fal') */
  vendor: 'fashn' | 'google' | 'fal'
  /** exact Fal queue endpoint id — only for Fal-backed engines */
  falEndpointId?: string
  status: EngineCommercialStatus
  modes: StudioModeId[]
  /** true → must never be offered for multi-person family presets */
  singlePersonOnly: boolean
  requiresEnv: EngineEnvKey
  /** kv flag that must be ON for this engine (Fal engines only) */
  settingsFlag?: EngineSettingsFlag
  /** false while the engine is foundation-only (declared, not yet wired) */
  runnable: boolean
  /** advertised list price, display-only — real spend comes from cost logs */
  approxCost?: string
  /** mandatory pre-Run warning for research-only engines (Bangla) */
  warningBn?: string
}

export const STUDIO_ENGINES: StudioEngine[] = [
  {
    id: 'fashn',
    label: 'FASHN Pro (direct)',
    labelBn: 'FASHN Pro',
    vendor: 'fashn',
    status: 'production',
    modes: ['product_to_model', 'try_on', 'model_swap', 'face_to_model', 'edit'],
    singlePersonOnly: true,
    requiresEnv: 'FASHN_API_KEY',
    runnable: true,
  },
  {
    id: 'gemini',
    label: 'Gemini (draft/fallback)',
    labelBn: 'Gemini (ড্রাফট)',
    vendor: 'google',
    status: 'production',
    modes: ['product_to_model', 'try_on', 'image_to_video'],
    singlePersonOnly: false,
    requiresEnv: 'GEMINI_API_KEY',
    runnable: true,
  },
  {
    id: 'fal_fashn_v16',
    label: 'Fal FASHN v1.6',
    labelBn: 'Fal FASHN v1.6',
    vendor: 'fal',
    falEndpointId: 'fal-ai/fashn/tryon/v1.6',
    status: 'commercial',
    modes: ['try_on'],
    singlePersonOnly: true,
    requiresEnv: 'FAL_KEY',
    settingsFlag: CS_FAL_ENABLED_KEY,
    runnable: true, // CS6: wired end to end (single Try-On only)
    approxCost: '~$0.075/generation',
  },
  {
    id: 'fal_idm_vton',
    label: 'IDM-VTON (experimental)',
    labelBn: 'IDM-VTON (পরীক্ষামূলক)',
    vendor: 'fal',
    falEndpointId: 'fal-ai/cat-vton',
    status: 'research_only',
    modes: ['try_on'],
    singlePersonOnly: true,
    requiresEnv: 'FAL_KEY',
    settingsFlag: CS_IDM_VTON_ENABLED_KEY,
    runnable: true, // CS6: wired end to end (single Try-On only, opt-in)
    warningBn:
      'পরীক্ষামূলক (research-only) ইঞ্জিন — ব্যবসায়িক ব্যবহারে লাইসেন্স ঝুঁকি আছে। ফলাফল নিজে যাচাই না করে পাবলিশ করবেন না।',
  },
  {
    id: 'fal_flux_fill',
    label: 'FLUX Fill (masked edit)',
    labelBn: 'FLUX Fill (মাস্ক এডিট)',
    vendor: 'fal',
    falEndpointId: 'fal-ai/flux-pro/v1/fill',
    status: 'commercial',
    modes: ['edit'],
    singlePersonOnly: false,
    requiresEnv: 'FAL_KEY',
    settingsFlag: CS_FLUX_FILL_ENABLED_KEY,
    runnable: true, // CS7: wired end to end (masked precision edit via worker)
    approxCost: '~$0.05/MP (রাউন্ড-আপ)',
  },
]

export function getEngine(id: StudioEngineId): StudioEngine {
  const engine = STUDIO_ENGINES.find((e) => e.id === id)
  if (!engine) throw new Error(`unknown studio engine: ${id}`)
  return engine
}

/** Engines that can serve a mode; multi-person family drops singlePersonOnly ones. */
export function enginesForMode(mode: StudioModeId, opts: { multiPerson?: boolean } = {}): StudioEngine[] {
  return STUDIO_ENGINES.filter(
    (e) => e.modes.includes(mode) && !(opts.multiPerson && e.singlePersonOnly),
  )
}

/** Legacy run/gallery provider values map 1:1 onto registry engine ids. */
export function resolveLegacyProvider(provider: StudioProvider): StudioEngine {
  return getEngine(provider)
}

/**
 * Server-side Fal endpoint allowlist — the ONLY endpoint ids a client-supplied
 * engine choice may reach. Mirrored in worker/src/fal/client.mjs (keep in sync).
 */
export const ALLOWED_FAL_ENDPOINTS: readonly string[] = STUDIO_ENGINES.filter(
  (e) => e.falEndpointId,
).map((e) => e.falEndpointId as string)

export function isAllowedFalEndpoint(endpointId: string): boolean {
  return ALLOWED_FAL_ENDPOINTS.includes(endpointId)
}

/** Valid owner choices for the single-person Try-On default (cs_single_vton_default). */
export const SINGLE_VTON_ENGINE_IDS: readonly StudioEngineId[] = STUDIO_ENGINES.filter(
  (e) => e.modes.includes('try_on') && e.singlePersonOnly,
).map((e) => e.id)

export function normalizeSingleVtonDefault(value: string | null | undefined): StudioEngineId {
  return SINGLE_VTON_ENGINE_IDS.includes(value as StudioEngineId)
    ? (value as StudioEngineId)
    : 'fashn'
}

/** CS6 — the two Fal-backed VTON engines an owner can pick for single Try-On. */
export const FAL_VTON_ENGINE_IDS: readonly StudioEngineId[] = ['fal_fashn_v16', 'fal_idm_vton']

export function isFalVtonEngine(id: string | null | undefined): id is 'fal_fashn_v16' | 'fal_idm_vton' {
  return FAL_VTON_ENGINE_IDS.includes(id as StudioEngineId)
}

/**
 * CS6 — cat-vton garment placement classes (owner-locked mapping, roadmap §CS6):
 * panjabi/long kurta/one-piece → overall; koti/waistcoat → outer;
 * pajama/bottom-only → lower; tunic/top-only → upper.
 */
export type VtonClothType = 'overall' | 'upper' | 'lower' | 'outer'
export const VTON_CLOTH_TYPES: readonly VtonClothType[] = ['overall', 'upper', 'lower', 'outer']

export function isVtonClothType(v: string | null | undefined): v is VtonClothType {
  return VTON_CLOTH_TYPES.includes(v as VtonClothType)
}

// ── CS12: model-specific kill switches + canary ──────────────────────────────

/** kv key per engine: '1' = killed. Enforced in the WORKER (jobs refuse to
 * run) and reflected in config availability — flipping it needs no redeploy. */
export const CS_ENGINE_KILL_PREFIX = 'cs_engine_kill:'
export function engineKillKey(id: StudioEngineId): string {
  return `${CS_ENGINE_KILL_PREFIX}${id}`
}

/** Owner-tunable canary percentage for a future Auto-default migration. Stored
 * and surfaced now; ROUTING enforcement deliberately waits for an owner
 * decision to migrate (CS10 verdict: no engine clearly ahead yet). */
export const CS_AUTO_CANARY_PCT_KEY = 'cs_auto_canary_pct'

export function normalizeCanaryPct(value: string | number | null | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}

/** Pure canary picker (unit-tested): route `canaryPct`% of runs to the candidate. */
export function applyCanary<T>(defaultEngine: T, candidateEngine: T, canaryPct: number, rand: () => number = Math.random): T {
  const pct = normalizeCanaryPct(canaryPct)
  if (pct <= 0) return defaultEngine
  return rand() * 100 < pct ? candidateEngine : defaultEngine
}

/**
 * Honest label for multi-person family renders. The backend runs the accuracy
 * chain (per-person FASHN try-on → Gemini merge), NOT a single Gemini call —
 * the UI used to say just "Gemini", which under-sold the FASHN steps.
 */
export const FAMILY_CHAIN_LABEL = 'FASHN + Gemini chain'
export const FAMILY_CHAIN_LABEL_BN = 'FASHN + Gemini চেইন'

export type EngineAvailability = {
  id: StudioEngineId
  label: string
  labelBn: string
  status: EngineCommercialStatus
  /** required env key is present on the server */
  configured: boolean
  /** owner kv flag is on (engines without a flag are always enabled) */
  enabled: boolean
  runnable: boolean
  singlePersonOnly: boolean
  approxCost: string | null
  warningBn: string | null
  /** CS12 — owner kill switch active (worker refuses jobs on this engine) */
  killed: boolean
}

/**
 * Availability snapshot for the config route. Missing keys/flags produce a
 * truthful `configured/enabled` state instead of a crash — unrelated modes
 * keep working when FAL_KEY is absent.
 */
export function describeEngineAvailability(input: {
  fashnConfigured: boolean
  geminiConfigured: boolean
  falConfigured: boolean
  flags: Partial<Record<EngineSettingsFlag, boolean>>
  /** CS12 — per-engine kill switches (killed ⇒ enabled:false regardless of flags) */
  kills?: Partial<Record<StudioEngineId, boolean>>
}): EngineAvailability[] {
  const envOk: Record<EngineEnvKey, boolean> = {
    FASHN_API_KEY: input.fashnConfigured,
    GEMINI_API_KEY: input.geminiConfigured,
    FAL_KEY: input.falConfigured,
  }
  return STUDIO_ENGINES.map((e) => {
    const killed = Boolean(input.kills?.[e.id])
    return {
      id: e.id,
      label: e.label,
      labelBn: e.labelBn,
      status: e.status,
      configured: envOk[e.requiresEnv],
      enabled: !killed && (e.settingsFlag ? Boolean(input.flags[e.settingsFlag]) : true),
      runnable: e.runnable,
      singlePersonOnly: e.singlePersonOnly,
      approxCost: e.approxCost ?? null,
      warningBn: e.warningBn ?? null,
      killed,
    }
  })
}
