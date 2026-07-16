/**
 * Phase 43 — UTM governance: one naming convention, generated + validated,
 * with campaign → ad set → ad → creative lineage that survives into
 * analytics. Pure functions, no IO.
 *
 * Convention (lowercase, [a-z0-9_-] only):
 *   utm_source   = meta | google | organic | referral | direct
 *   utm_medium   = paid_social | organic_social | cpc | email | sms | messenger
 *   utm_campaign = alma_<objective>_<yyyymm>[_<slug>]
 *   utm_content  = <adsetKey>__<adKey>__<creativeKey>   (double underscore separators)
 *   utm_term     = optional audience/keyword slug
 */

export const UTM_SOURCES = ['meta', 'google', 'organic', 'referral', 'direct'] as const
export const UTM_MEDIUMS = ['paid_social', 'organic_social', 'cpc', 'email', 'sms', 'messenger'] as const

export interface UtmParams {
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_content?: string
  utm_term?: string
}

export interface UtmLineage {
  campaignKey: string
  adsetKey: string | null
  adKey: string | null
  creativeKey: string | null
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/

/** Normalize free text into a convention-safe slug. */
export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_{2,}/g, '_') || 'x'
  )
}

/** Build the canonical campaign name: alma_<objective>_<yyyymm>[_<slug>]. */
export function buildCampaignSlug(opts: { objective: string; yyyymm: string; slug?: string }): string {
  if (!/^\d{6}$/.test(opts.yyyymm)) throw new Error('yyyymm must be 6 digits, e.g. 202607')
  const base = `alma_${slugify(opts.objective)}_${opts.yyyymm}`
  return opts.slug ? `${base}_${slugify(opts.slug)}` : base
}

/** Generate a full UTM set with lineage packed into utm_content. */
export function buildUtm(opts: {
  source: (typeof UTM_SOURCES)[number]
  medium: (typeof UTM_MEDIUMS)[number]
  campaign: string
  adsetKey?: string
  adKey?: string
  creativeKey?: string
  term?: string
}): UtmParams {
  const utm: UtmParams = {
    utm_source: opts.source,
    utm_medium: opts.medium,
    utm_campaign: slugCheck(opts.campaign, 'campaign'),
  }
  if (opts.adsetKey || opts.adKey || opts.creativeKey) {
    utm.utm_content = [
      slugify(opts.adsetKey ?? 'na'),
      slugify(opts.adKey ?? 'na'),
      slugify(opts.creativeKey ?? 'na'),
    ].join('__')
  }
  if (opts.term) utm.utm_term = slugify(opts.term)
  return utm
}

function slugCheck(value: string, label: string): string {
  const v = value.trim().toLowerCase()
  if (!SLUG_RE.test(v.replace(/__/g, '_'))) throw new Error(`invalid utm ${label} "${value}" — use [a-z0-9_-]`)
  return v
}

export interface UtmValidation {
  ok: boolean
  errors: string[]
}

/** Validate a UTM set against the convention (used before any link ships). */
export function validateUtm(utm: Partial<UtmParams>): UtmValidation {
  const errors: string[] = []
  if (!utm.utm_source) errors.push('utm_source missing')
  else if (!(UTM_SOURCES as readonly string[]).includes(utm.utm_source)) errors.push(`utm_source "${utm.utm_source}" not in convention`)
  if (!utm.utm_medium) errors.push('utm_medium missing')
  else if (!(UTM_MEDIUMS as readonly string[]).includes(utm.utm_medium)) errors.push(`utm_medium "${utm.utm_medium}" not in convention`)
  if (!utm.utm_campaign) errors.push('utm_campaign missing')
  else if (!utm.utm_campaign.startsWith('alma_')) errors.push('utm_campaign must start with alma_')
  else if (!SLUG_RE.test(utm.utm_campaign)) errors.push('utm_campaign has invalid characters')
  if (utm.utm_content && utm.utm_content.split('__').length !== 3) {
    errors.push('utm_content must be <adsetKey>__<adKey>__<creativeKey>')
  }
  return { ok: errors.length === 0, errors }
}

/** Recover campaign→adset→ad→creative lineage from a UTM set. */
export function parseLineage(utm: Partial<UtmParams>): UtmLineage | null {
  if (!utm.utm_campaign) return null
  const parts = utm.utm_content?.split('__') ?? []
  const clean = (s: string | undefined) => (s && s !== 'na' ? s : null)
  return {
    campaignKey: utm.utm_campaign,
    adsetKey: clean(parts[0]),
    adKey: clean(parts[1]),
    creativeKey: clean(parts[2]),
  }
}

/** Append UTM params to a URL (existing utm_* params are replaced, never duplicated). */
export function applyUtmToUrl(url: string, utm: UtmParams): string {
  const u = new URL(url)
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    u.searchParams.delete(key)
  }
  for (const [k, v] of Object.entries(utm)) {
    if (v) u.searchParams.set(k, v)
  }
  return u.toString()
}
