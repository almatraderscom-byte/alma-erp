import { upcomingSeasons } from '@/lib/marketing-calendar'
import type { BrandTheme } from '@/lib/content-engine/brand-identity'
import type { TryOnStyle } from '@/lib/tryon/model-library'

export type ResolvedContentTheme = {
  theme: BrandTheme
  hook: string
  tryOnStyle: TryOnStyle
  /** Human label for monitor / logs */
  label: string
  festivalActive: boolean
  isFriday: boolean
}

function isFridayDhaka(now = new Date()): boolean {
  const wd = now.toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka', weekday: 'short' })
  return wd === 'Fri'
}

/**
 * Festival / Friday / default theming for captions, brand frame palette, and try-on style.
 * Logo + layout unchanged — only accent palette and hook vary (brand identity intact).
 */
export async function resolveTheme(now = new Date()): Promise<ResolvedContentTheme> {
  const seasons = await upcomingSeasons()
  const active = seasons.find((s) => s.inLeadWindow)
  const friday = isFridayDhaka(now)

  if (active?.key === 'eid_fitr' || active?.key === 'eid_adha') {
    return {
      theme: 'eid',
      hook: 'ঈদ স্পেশাল কালেকশন',
      tryOnStyle: 'festival',
      label: 'ঈদ',
      festivalActive: true,
      isFriday: friday,
    }
  }
  if (active?.key === 'pahela_baishakh') {
    return {
      theme: 'boishakh',
      hook: 'পহেলা বৈশাখ স্পেশাল',
      tryOnStyle: 'festival',
      label: 'বৈশাখ',
      festivalActive: true,
      isFriday: friday,
    }
  }
  if (active?.key === 'puja') {
    return {
      theme: 'puja',
      hook: 'পূজা স্পেশাল',
      tryOnStyle: 'festival',
      label: 'পূজা',
      festivalActive: true,
      isFriday: friday,
    }
  }
  if (active?.key === 'winter') {
    return {
      theme: 'winter',
      hook: 'শীত কালেকশন',
      tryOnStyle: 'outdoor_bd',
      label: 'শীত',
      festivalActive: true,
      isFriday: friday,
    }
  }
  if (friday) {
    return {
      theme: 'default',
      hook: 'জুম্মার দিন — উইকেন্ড কালেকশন',
      tryOnStyle: 'lifestyle',
      label: 'জুম্মা',
      festivalActive: false,
      isFriday: true,
    }
  }
  return {
    theme: 'default',
    hook: 'নতুন কালেকশন',
    tryOnStyle: 'studio',
    label: 'ডিফল্ট',
    festivalActive: false,
    isFriday: false,
  }
}
