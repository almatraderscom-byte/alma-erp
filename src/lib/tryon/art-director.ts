import { agentStorageDownload } from '@/agent/lib/storage'
import { logCost } from '@/agent/lib/cost-events'

const VISION_MODEL = 'gemini-2.0-flash'
const CACHE_PREFIX = 'tryon_garment_attrs:'

export type TryOnStyle = 'studio' | 'outdoor_bd' | 'festival' | 'lifestyle'
export type TryOnPose = 'front' | 'three_quarter' | 'walking' | 'sitting' | 'detail'

export const BD_REALISM_BASE =
  'Photorealistic professional fashion photograph shot in Bangladesh. ' +
  'Natural South Asian (Bangladeshi) setting and lighting, authentic local environment, ' +
  'realistic skin tones for a Bangladeshi person, true-to-life fabric drape and texture. ' +
  'Shot on a full-frame DSLR, 85mm lens, shallow depth of field, soft natural light. ' +
  'NOT a foreign/Western studio look — the background, light quality, and overall mood must read as a real Bangladeshi photoshoot. ' +
  'High resolution, sharp focus on the garment, e-commerce ready.'

export const STYLE_DIRECTION: Record<TryOnStyle, string> = {
  studio:
    'Clean professional studio backdrop in soft neutral tone (warm off-white or muted), even softbox lighting, minimal shadows — classic e-commerce on-model shot.',
  outdoor_bd:
    'Real Bangladeshi outdoor location — e.g. an old Dhaka street, a heritage building courtyard, a rooftop at golden hour, or lush greenery. Authentic local architecture and ambience, natural daylight.',
  festival:
    'Warm festive Bangladeshi setting suitable for Eid/wedding — tasteful decorative elements, warm golden ambient light, celebratory but not cluttered; keeps full focus on the outfit.',
  lifestyle:
    'Candid lifestyle scene in a relatable Bangladeshi everyday setting (cafe, home interior, urban street), natural and unposed feel.',
}

export const POSE_DIRECTION: Record<TryOnPose, string> = {
  front: 'Model facing camera, full front view, relaxed confident posture, full outfit clearly visible.',
  three_quarter: "Model at a three-quarter angle, showing the garment's silhouette and side drape.",
  walking: 'Model captured mid-stride walking toward camera, natural movement, fabric in motion.',
  sitting: 'Model seated in a natural, elegant pose, garment arranged to show its fit and detail.',
  detail: 'Closer framing emphasizing fabric texture, embroidery, and craftsmanship of the garment.',
}

export type GarmentType =
  | 'panjabi'
  | 'short_panjabi'
  | 'koti_set'
  | 'pajama_panjabi_set'
  | 'kids_panjabi'
  | 'family_matching_set'
  | 'kurta'
  | 'unknown'

export type GarmentRole = 'father' | 'son' | 'single' | 'family'

export type GarmentAttrs = {
  garmentType: GarmentType
  dominantColors: string[]
  fabricGuess: string
  embroideryZones: string[]
  hasContrastBottom: boolean
  suggestedRole: GarmentRole
  notes: string
}

interface GarmentSpec {
  label: string
  anatomy: string
  fidelity: string
}

export const GARMENT_SPECS: Record<GarmentType, GarmentSpec> = {
  panjabi: {
    label: "Men's Panjabi",
    anatomy:
      'Full-length traditional Bangladeshi men\'s panjabi — the hemline must fall BELOW THE KNEE (roughly mid-calf to lower-thigh, the standard length a Bangladeshi man wears), never a short kurta length. Match the exact length shown in the product photo and keep it long on this model\'s frame. Reproduce EXACTLY: collar type (band/Chinese/mandarin or hooded as shown), full-button placket with the same button count, material and color, sleeve length to wrist, cuff style, side slits, and hemline length as in the product photo.',
    fidelity:
      "Embroidery zones (collar, placket, chest, cuff, hem) must replicate the product's stitch pattern, density, motif and placement precisely — do not move, add, simplify, or restyle any embroidery. Keep thread color and sheen (zari/karchupi/computer embroidery) identical.",
  },
  short_panjabi: {
    label: 'Short Panjabi / Kurta',
    anatomy:
      'Shorter hemline at hip level, straight or slightly curved hem. Preserve collar, placket button count, and sleeve length exactly.',
    fidelity:
      'Match print/embroidery placement and scale exactly; short panjabis often have a single chest motif — keep it identical in size and position.',
  },
  koti_set: {
    label: 'Koti (waistcoat) over Panjabi',
    anatomy:
      "A sleeveless koti/waistcoat layered over a panjabi. Render BOTH layers: the koti's exact cut, button line, collar/lapel, and the panjabi visible at sleeves and hem.",
    fidelity:
      'Koti fabric and panjabi fabric are usually different — preserve each material and color separately; do not blend them.',
  },
  pajama_panjabi_set: {
    label: 'Panjabi + Pajama/Churidar set',
    anatomy:
      'Full set: panjabi top + matching or contrast pajama/churidar bottom. Show the bottom\'s correct fit (loose pajama vs fitted churidar with ankle gathers) as in the product.',
    fidelity:
      'Match top and bottom fabric/color relationship exactly (matching set vs contrast).',
  },
  kids_panjabi: {
    label: 'Kids Panjabi',
    anatomy:
      'Child-proportioned panjabi. Keep child body proportions natural; do not adult-ify the face or frame.',
    fidelity:
      'Same embroidery-fidelity rules; kids sets often mirror the adult design — keep the motif consistent if a matching family set.',
  },
  family_matching_set: {
    label: 'Family Matching Set',
    anatomy:
      "Coordinated outfits across family members sharing a design language (same fabric/motif, sized per role). Each member's garment must match their role's cut while keeping the shared design.",
    fidelity:
      'The "matching" is the selling point — the shared motif/color/fabric MUST be visibly consistent across all members while fitting each body naturally.',
  },
  kurta: {
    label: 'Kurta',
    anatomy:
      'Lighter, often straight-cut kurta. Preserve neckline, placket, and length exactly.',
    fidelity:
      'Match print scale and placement precisely.',
  },
  unknown: {
    label: 'Garment',
    anatomy:
      'Reproduce the garment exactly as shown — cut, length, collar, sleeves, closures.',
    fidelity:
      'Match color, fabric, pattern and all design details at 99% accuracy; do not redesign.',
  },
}

const VALID_GARMENT_TYPES = new Set<string>(Object.keys(GARMENT_SPECS))
const VALID_ROLES = new Set<string>(['father', 'son', 'single', 'family'])

export const NEGATIVE_DIRECTIVES =
  "STRICTLY AVOID: changing the garment's color, pattern, embroidery, cut or length; " +
  'adding any motif, logo, text, or jewelry not present in the product; ' +
  'redesigning or "improving" the outfit; westernizing the garment or the model\'s face; ' +
  'plastic/over-smoothed AI skin, waxy highlights, or beauty-filter slimming of the model; ' +
  'warped or extra fingers/hands, distorted limbs, asymmetric eyes; ' +
  'gibberish text on fabric or signage; oversharpened halos; warped embroidery across fabric folds. ' +
  "The model's face, age, skin tone and body type from Image 1 must remain unchanged."

const CLASSIFY_PROMPT = `Analyze this clothing PRODUCT photo for a Bangladeshi men's/family ethnic-wear brand. Return STRICT JSON:
{ "garmentType": one of [panjabi,short_panjabi,koti_set,pajama_panjabi_set,kids_panjabi,family_matching_set,kurta,unknown],
  "dominantColors": ["..."],
  "fabricGuess": "...",
  "embroideryZones": ["collar","placket","chest","cuff","hem"],
  "hasContrastBottom": false,
  "suggestedRole": one of [father,son,single,family],
  "notes": "any distinctive detail to preserve (specific motif, unusual collar, etc.)" }
Only describe what is visibly present. If unsure, use "unknown". No prose, JSON only.`

const UNKNOWN_ATTRS: GarmentAttrs = {
  garmentType: 'unknown',
  dominantColors: [],
  fabricGuess: '',
  embroideryZones: [],
  hasContrastBottom: false,
  suggestedRole: 'single',
  notes: '',
}

export function normalizeGarmentType(value?: string | null, fallback?: GarmentType): GarmentType {
  if (!value) return fallback ?? 'unknown'
  const v = value.toLowerCase().trim().replace(/\s+/g, '_')
  if (VALID_GARMENT_TYPES.has(v)) return v as GarmentType
  if (/koti|waistcoat|vest/.test(v)) return 'koti_set'
  if (/family|matching/.test(v)) return 'family_matching_set'
  if (/kid|boy|child/.test(v)) return 'kids_panjabi'
  if (/pajama|churidar|set/.test(v)) return 'pajama_panjabi_set'
  if (/short.*panjabi|short.*kurta/.test(v)) return 'short_panjabi'
  if (/kurta/.test(v)) return 'kurta'
  if (/panjabi|punjabi/.test(v)) return 'panjabi'
  return fallback ?? 'unknown'
}

function parseGarmentAttrs(raw: unknown): GarmentAttrs {
  if (!raw || typeof raw !== 'object') return { ...UNKNOWN_ATTRS }
  const o = raw as Record<string, unknown>
  const garmentType = normalizeGarmentType(typeof o.garmentType === 'string' ? o.garmentType : undefined)
  const dominantColors = Array.isArray(o.dominantColors)
    ? o.dominantColors.map(String).filter(Boolean)
    : []
  const embroideryZones = Array.isArray(o.embroideryZones)
    ? o.embroideryZones.map(String).filter(Boolean)
    : []
  const suggestedRole = typeof o.suggestedRole === 'string' && VALID_ROLES.has(o.suggestedRole)
    ? (o.suggestedRole as GarmentRole)
    : 'single'

  return {
    garmentType,
    dominantColors,
    fabricGuess: typeof o.fabricGuess === 'string' ? o.fabricGuess : '',
    embroideryZones,
    hasContrastBottom: o.hasContrastBottom === true,
    suggestedRole,
    notes: typeof o.notes === 'string' ? o.notes : '',
  }
}

async function readGarmentCache(cacheKey: string): Promise<GarmentAttrs | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (await import('@/lib/prisma')).prisma.agentKvSetting.findUnique({
      where: { key: cacheKey },
    })
    if (!row?.value) return null
    return parseGarmentAttrs(JSON.parse(row.value))
  } catch (err) {
    console.warn('[art-director] cached garment attrs read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

async function writeGarmentCache(cacheKey: string, attrs: GarmentAttrs): Promise<void> {
  try {
    const { prisma } = await import('@/lib/prisma')
    await prisma.agentKvSetting.upsert({
      where: { key: cacheKey },
      create: { key: cacheKey, value: JSON.stringify(attrs) },
      update: { value: JSON.stringify(attrs) },
    })
  } catch (err) {
    console.warn('[art-director] garment attrs cache write failed:', err instanceof Error ? err.message : err)
  }
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

export async function classifyGarment(productImagePath: string): Promise<GarmentAttrs> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return { ...UNKNOWN_ATTRS }

  let buffer: Buffer
  try {
    buffer = await agentStorageDownload(productImagePath)
  } catch (err) {
    console.warn('[art-director] product image download failed:', err instanceof Error ? err.message : err)
    return { ...UNKNOWN_ATTRS }
  }

  const mimeType = mimeFromPath(productImagePath)
  const base64 = buffer.toString('base64')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${key}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: CLASSIFY_PROMPT },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) return { ...UNKNOWN_ATTRS }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    const parsed = parseGarmentAttrs(JSON.parse(jsonMatch?.[0] ?? '{}'))

    const tokensIn = data.usageMetadata?.promptTokenCount ?? 400
    const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 150
    void logCost({
      provider: 'gemini',
      kind: 'cs_vision',
      units: { model: VISION_MODEL, tokens_in: tokensIn, tokens_out: tokensOut, purpose: 'garment_classify' },
      costUsd: 0.0001,
      dedupKey: `garment_classify:${productImagePath}`,
    })

    return parsed
  } catch (err) {
    console.warn('[art-director] garment attrs analysis failed:', err instanceof Error ? err.message : err)
    return { ...UNKNOWN_ATTRS }
  }
}

/** Classify once per product image — cached in agent_kv_settings. */
export async function getOrClassifyGarment(
  productImagePath: string,
  productCode?: string | null,
): Promise<GarmentAttrs> {
  const keys = [
    productCode ? `${CACHE_PREFIX}code:${productCode}` : null,
    `${CACHE_PREFIX}path:${productImagePath}`,
  ].filter(Boolean) as string[]

  for (const key of keys) {
    const cached = await readGarmentCache(key)
    if (cached) return cached
  }

  const attrs = await classifyGarment(productImagePath)
  for (const key of keys) {
    await writeGarmentCache(key, attrs)
  }
  return attrs
}

/**
 * Garment types that are a panjabi/kurta top WITHOUT a bottom defined in the
 * product. For these, the model must be dressed in a plain white pajama bottom —
 * how a Bangladeshi man actually wears a panjabi. We deliberately EXCLUDE
 * pajama_panjabi_set (its bottom is part of the product) and family_matching_set
 * (handled per-role). This is the owner's standing rule: "panjabi-r sathe white
 * pajama must thakbe."
 */
const PANJABI_TOPS_NEEDING_WHITE_PAJAMA = new Set<GarmentType>([
  'panjabi',
  'short_panjabi',
  'kurta',
  'koti_set',
  'kids_panjabi',
])

const WHITE_PAJAMA_DIRECTIVE =
  'BOTTOM: pair the panjabi with a plain WHITE loose pajama (traditional Bangladeshi pyjama trousers) — clean solid white, no print, natural fabric drape, correct length ending at the ankles. The model must NOT be bare-legged, in jeans, in trousers, or in churidar; always a simple white pajama unless the product photo itself clearly includes a different bottom.'

export function buildArtDirectorPrompt(opts: {
  garmentType?: GarmentType
  attrs?: GarmentAttrs
  style?: TryOnStyle
  pose?: TryOnPose
  modelNotes?: string
  extra?: string
  referenceBlock?: string
}): string {
  const garmentType = opts.garmentType ?? opts.attrs?.garmentType ?? 'unknown'
  const spec = GARMENT_SPECS[garmentType]
  const a = opts.attrs
  // Only add the white-pajama bottom when the product itself doesn't already
  // define a bottom (attrs.hasContrastBottom) — otherwise we'd override the
  // product's real bottom.
  const needsWhitePajama =
    PANJABI_TOPS_NEEDING_WHITE_PAJAMA.has(garmentType) && !(a?.hasContrastBottom === true)
  const attrLine = a
    ? `Detected garment: ${a.garmentType}; colors: ${a.dominantColors?.join(', ') || 'n/a'}; fabric: ${a.fabricGuess || 'n/a'}; embroidery at: ${a.embroideryZones?.join(', ') || 'none'}.${a.notes ? ` Preserve this detail exactly: ${a.notes}.` : ''}`
    : ''

  return [
    'TASK: Professional virtual try-on for an e-commerce product listing.',
    'Image 1 = the MODEL (a real person, identity to KEEP). Image 2 = the PRODUCT garment (to reproduce).',
    'Dress the MODEL from Image 1 in the EXACT garment from Image 2.',
    `GARMENT TYPE — ${spec.label}. ${spec.anatomy}`,
    `GARMENT FIDELITY (99% rule) — ${spec.fidelity}`,
    needsWhitePajama ? WHITE_PAJAMA_DIRECTIVE : '',
    attrLine,
    "MODEL IDENTITY — Preserve the model's face, facial hair, age, skin tone and body type from Image 1 with no beautification or reshaping. Fit the garment naturally to THIS body: correct shoulder seams, sleeve and hem length on this frame, realistic fabric drape, embroidery undistorted across folds.",
    BD_REALISM_BASE,
    `COMPOSITION: ${STYLE_DIRECTION[opts.style ?? 'studio']}`,
    `POSE: ${POSE_DIRECTION[opts.pose ?? 'front']}`,
    opts.modelNotes ? `Model characteristics: ${opts.modelNotes}.` : '',
    opts.referenceBlock ?? '',
    opts.extra ?? '',
    'OUTPUT: high-resolution, sharp focus on the garment, accurate color, e-commerce ready.',
    NEGATIVE_DIRECTIVES,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * CS6 — map the classified garment type onto the cat-vton placement class
 * (owner-locked, roadmap §CS6): panjabi/long kurta/one-piece → overall;
 * koti/waistcoat → outer; bottom-only → lower; tunic/top-only → upper.
 * Our catalogue is panjabi-first, so everything long defaults to overall.
 * `uncertain` tells the UI to surface the owner-visible override.
 */
export function mapGarmentToVtonClothType(attrs: GarmentAttrs | null | undefined): {
  clothType: 'overall' | 'upper' | 'lower' | 'outer'
  uncertain: boolean
} {
  const t = attrs?.garmentType ?? 'unknown'
  switch (t) {
    case 'panjabi':
    case 'kids_panjabi':
    case 'pajama_panjabi_set':
    case 'family_matching_set':
      return { clothType: 'overall', uncertain: false }
    case 'kurta':
    case 'short_panjabi':
      // hip-length tops read as upper for VTON placement
      return { clothType: t === 'short_panjabi' ? 'upper' : 'overall', uncertain: false }
    case 'koti_set':
      return { clothType: 'outer', uncertain: false }
    default:
      return { clothType: 'overall', uncertain: true }
  }
}

/**
 * CS6 — the same garment classes mapped onto Fal FASHN v1.6 categories
 * (tops / bottoms / one-pieces / auto).
 */
export function mapGarmentToFashnCategory(attrs: GarmentAttrs | null | undefined): string {
  const t = attrs?.garmentType ?? 'unknown'
  if (t === 'koti_set' || t === 'short_panjabi' || t === 'kurta') return 'tops'
  if (t === 'panjabi' || t === 'kids_panjabi' || t === 'pajama_panjabi_set' || t === 'family_matching_set') return 'one-pieces'
  return 'auto'
}

export function buildTryOnPrompt(opts: {
  style?: TryOnStyle
  pose?: TryOnPose
  modelNotes?: string
  garmentType?: GarmentType | string
  attrs?: GarmentAttrs
  extra?: string
  referenceBlock?: string
}): string {
  const garmentType = normalizeGarmentType(
    typeof opts.garmentType === 'string' ? opts.garmentType : opts.garmentType,
    opts.attrs?.garmentType,
  )
  return buildArtDirectorPrompt({
    garmentType,
    attrs: opts.attrs,
    style: opts.style,
    pose: opts.pose,
    modelNotes: opts.modelNotes,
    extra: opts.extra,
    referenceBlock: opts.referenceBlock,
  })
}
