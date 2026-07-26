import {
  fetchAudioLabStatus,
  fetchBrandRecipes,
  fetchCreativeVoices,
  fetchErpProducts,
  fetchGallery,
  fetchModels,
  fetchMusicTracks,
  fetchStudioBrands,
  fetchStudioConfig,
  fetchStudioHealth,
  fetchStudioProjects,
  fetchStudioRetention,
  fetchStudioSettings,
  fetchStudioVideos,
  fetchVideoEditSource,
  finishImage,
  finishVideo,
  partiallyFinishVideo,
  runAutoStudioJob,
  runStudioJob,
  runVideoRecipe,
  uploadFillMask,
  uploadStudioFile,
  uploadStudioVideo,
} from '@/agent/components/creative-studio/studio-api'
import type {
  CreativeStudioV3ProductionPort,
  StudioV3DataIssue,
  StudioV3HomeSnapshot,
} from '@/agent/components/creative-studio-v3/ports'
import { scopeProjectsToBrand } from '@/agent/components/creative-studio-v3/ui-contract'

function issue(resource: string, reason: unknown): StudioV3DataIssue {
  return {
    resource,
    message: reason instanceof Error ? reason.message : 'The production service did not respond.',
  }
}

export async function loadCreativeStudioV3Home(
  brandProfileId?: string | null,
): Promise<StudioV3HomeSnapshot> {
  const resources = await Promise.allSettled([
    fetchStudioBrands(),
    fetchStudioProjects(),
    fetchBrandRecipes(brandProfileId),
    fetchModels(),
    fetchGallery({ limit: 12 }),
    fetchStudioConfig(),
    fetchStudioHealth(),
    fetchStudioRetention(),
  ])

  const issues: StudioV3DataIssue[] = []
  const value = <T,>(index: number, resource: string, fallback: T): T => {
    const result = resources[index]
    if (result.status === 'fulfilled') return result.value as T
    issues.push(issue(resource, result.reason))
    return fallback
  }

  return {
    brands: value(0, 'brands', []),
    projects: scopeProjectsToBrand(value(1, 'projects', []), brandProfileId),
    recipes: value(2, 'recipes', []),
    models: value<{ models: StudioV3HomeSnapshot['models'] }>(3, 'models', { models: [] }).models,
    recentAssets: value<{ items: StudioV3HomeSnapshot['recentAssets'] }>(4, 'gallery', { items: [] }).items,
    config: value(5, 'config', null),
    health: value(6, 'health', null),
    retention: value(7, 'retention', null),
    issues,
  }
}

export const creativeStudioV3ProductionPort: CreativeStudioV3ProductionPort = {
  loadHome: loadCreativeStudioV3Home,
  listBrands: fetchStudioBrands,
  listProjects: async (brandProfileId) => scopeProjectsToBrand(
    await fetchStudioProjects(),
    brandProfileId,
  ),
  listRecipes: fetchBrandRecipes,
  listProducts: fetchErpProducts,
  // These legacy endpoints are authenticated and owner-only, and expose no
  // brand key. Accepting the selected brand keeps the UI port future-ready and
  // forces callers to make scope explicit; it must not be mistaken for a
  // server brand filter or collaborator access.
  listModels: async (_brandProfileId) => (await fetchModels()).models ?? [],
  listGallery: async (query, _brandProfileId) => fetchGallery(query),
  listVoices: async (_brandProfileId) => fetchCreativeVoices(),
  listVideoUploads: async (_brandProfileId) => fetchStudioVideos(),
  listMusicTracks: async (_brandProfileId) => fetchMusicTracks(),
  getConfig: fetchStudioConfig,
  getSettings: fetchStudioSettings,
  getHealth: fetchStudioHealth,
  getAudioStatus: fetchAudioLabStatus,
  uploadImage: uploadStudioFile,
  uploadVideo: uploadStudioVideo,
  queueAdvancedImage: runStudioJob,
  queueAutoImage: runAutoStudioJob,
  queueOwnedVideo: runVideoRecipe,
  getVideoEditSource: fetchVideoEditSource,
  finishImage,
  queueMaskedEdit: (input) => runStudioJob({
    mode: 'edit',
    sourceImagePath: input.sourceImagePath,
    maskPath: input.maskPath,
    maskPreset: input.maskPreset,
    prompt: input.prompt,
    baseWidth: input.baseWidth,
    baseHeight: input.baseHeight,
  }),
  uploadMask: uploadFillMask,
  finishVideo,
  partiallyFinishVideo,
}
