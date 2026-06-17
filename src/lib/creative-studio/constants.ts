import type { ChatTryOnVariant } from '@/lib/tryon/tryon-batch'
import type { FashnModelName, FashnResolution, FashnGenerationMode } from '@/lib/fashn/types'

export type StudioModeId =
  | 'product_to_model'
  | 'try_on'
  | 'model_swap'
  | 'face_to_model'
  | 'edit'
  | 'image_to_video'

export type StudioProvider = 'fashn' | 'gemini'

export type FamilyPresetId = ChatTryOnVariant

export const STUDIO_MODES: Array<{
  id: StudioModeId
  label: string
  short: string
  fashnModel?: FashnModelName
  needsProduct: boolean
  needsModel: boolean
  needsSource?: boolean
  isVideo?: boolean
}> = [
  { id: 'product_to_model', label: 'Product to Model', short: 'Product→Model', fashnModel: 'product-to-model', needsProduct: true, needsModel: false },
  { id: 'try_on', label: 'Try-On', short: 'Try-On', fashnModel: 'tryon-max', needsProduct: true, needsModel: true },
  { id: 'model_swap', label: 'Model Swap', short: 'Swap', fashnModel: 'model-swap', needsProduct: false, needsModel: true, needsSource: true },
  { id: 'face_to_model', label: 'Face to Model', short: 'Face', fashnModel: 'face-to-model', needsProduct: false, needsModel: true },
  { id: 'edit', label: 'Edit', short: 'Edit', fashnModel: 'edit', needsProduct: false, needsModel: false, needsSource: true },
  { id: 'image_to_video', label: 'Image to Video', short: 'Reel', isVideo: true, needsProduct: false, needsModel: false, needsSource: true },
]

export const FAMILY_PRESETS: Array<{ id: FamilyPresetId; label: string; labelBn: string }> = [
  { id: 'single', label: 'Single', labelBn: 'Single' },
  { id: 'father_son', label: 'Baba + Chele', labelBn: 'বাবা + ছেলে' },
  { id: 'mother_daughter', label: 'Ma + Meyе', labelBn: 'মা + মেয়ে' },
  { id: 'mother_son', label: 'Ma + Chele', labelBn: 'মা + ছেলে' },
  { id: 'full_family', label: 'Full Family', labelBn: 'পুরো ফ্যামিলি' },
]

export const ASPECT_RATIOS = ['4:5', '1:1', '9:16', '16:9'] as const
export const RESOLUTIONS: FashnResolution[] = ['1k', '2k', '4k']
export const GEN_MODES: FashnGenerationMode[] = ['fast', 'balanced', 'quality']

export const BACKGROUND_PRESETS = [
  { id: 'studio', label: 'Studio', prompt: 'clean professional studio backdrop, soft even lighting' },
  { id: 'outdoor_bd', label: 'Outdoor BD', prompt: 'Bangladeshi outdoor golden hour, natural street or greenery' },
  { id: 'festival', label: 'Festival', prompt: 'warm festive Eid atmosphere, tasteful decor' },
  { id: 'lifestyle', label: 'Lifestyle', prompt: 'relatable Bangladeshi cafe or home interior' },
  { id: 'custom', label: 'Custom', prompt: '' },
] as const

export const VIDEO_VIBES = [
  { id: 'premium', label: 'Premium' },
  { id: 'festival', label: 'Festival' },
  { id: 'offer', label: 'Offer' },
  { id: 'lifestyle', label: 'Lifestyle' },
] as const
