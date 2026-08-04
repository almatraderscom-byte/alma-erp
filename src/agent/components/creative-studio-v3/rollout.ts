import 'server-only'

import {
  resolveCreativeStudioV3Rollout,
  type CreativeStudioV3RolloutScope,
} from '@/agent/components/creative-studio-v3/rollout-policy'

export function isCreativeStudioV3Enabled(scope: CreativeStudioV3RolloutScope): boolean {
  return resolveCreativeStudioV3Rollout({
    CREATIVE_STUDIO_V3_UI_ENABLED: process.env.CREATIVE_STUDIO_V3_UI_ENABLED,
    CREATIVE_STUDIO_V3_OWNER_IDS: process.env.CREATIVE_STUDIO_V3_OWNER_IDS,
    CREATIVE_STUDIO_V3_BRAND_IDS: process.env.CREATIVE_STUDIO_V3_BRAND_IDS,
    CREATIVE_STUDIO_V3_PROJECT_IDS: process.env.CREATIVE_STUDIO_V3_PROJECT_IDS,
  }, scope)
}
