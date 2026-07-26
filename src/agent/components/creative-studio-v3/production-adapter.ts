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
  fetchStudioReviewQueue,
  fetchStudioRetention,
  fetchStudioSettings,
  fetchStudioVideos,
  fetchVideoEditSource,
  finishImage,
  finishVideo,
  confirmStudioJob,
  estimateStudioJob,
  partiallyFinishVideo,
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
  projectId?: string | null,
): Promise<StudioV3HomeSnapshot> {
  const resources = await Promise.allSettled([
    fetchStudioBrands(),
    fetchStudioProjects(brandProfileId),
    fetchBrandRecipes(brandProfileId),
    fetchModels(brandProfileId, projectId),
    fetchGallery({ limit: 12, brandProfileId, projectId }),
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
    await fetchStudioProjects(brandProfileId),
    brandProfileId,
  ),
  listRecipes: fetchBrandRecipes,
  listProducts: fetchErpProducts,
  // V3 reads require both brand and project. Server routes validate the actor's
  // assignment and exclude every unscoped legacy resource.
  listModels: async (brandProfileId, projectId) =>
    (await fetchModels(brandProfileId, projectId)).models ?? [],
  listGallery: async (query, brandProfileId, projectId) =>
    fetchGallery({ ...query, brandProfileId, projectId }),
  listVoices: fetchCreativeVoices,
  listVideoUploads: fetchStudioVideos,
  listMusicTracks: fetchMusicTracks,
  listReviewQueue: fetchStudioReviewQueue,
  getConfig: fetchStudioConfig,
  getSettings: fetchStudioSettings,
  getHealth: fetchStudioHealth,
  getAudioStatus: fetchAudioLabStatus,
  uploadImage: uploadStudioFile,
  uploadVideo: uploadStudioVideo,
  estimateRun: estimateStudioJob,
  confirmRun: confirmStudioJob,
  getVideoEditSource: fetchVideoEditSource,
  finishImage,
  uploadMask: uploadFillMask,
  finishVideo,
  partiallyFinishVideo,
}
