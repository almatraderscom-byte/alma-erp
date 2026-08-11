import { describe, expect, it } from 'vitest'
import {
  shouldEmitGenericJobSuccess,
  shouldResumeAgentAfterImageWorkflow,
  shouldResumeAgentAfterJob,
} from '@/agent/lib/job-result-message-policy'

describe('worker callback message policy', () => {
  it('does not impersonate an owner/agent turn when an SEO audit completes', () => {
    expect(shouldEmitGenericJobSuccess('seo_audit')).toBe(false)
  })

  it('preserves the existing generic callback for unrelated jobs', () => {
    expect(shouldEmitGenericJobSuccess('legacy_background_job')).toBe(true)
  })

  it('resumes SEO only after a successful worker result', () => {
    expect(shouldResumeAgentAfterJob('seo_audit', 'success')).toBe(true)
    expect(shouldResumeAgentAfterJob('seo_audit', 'failed')).toBe(false)
    expect(shouldResumeAgentAfterJob('image_gen', 'success')).toBe(false)
  })

  it('resumes image delivery only at the product-post preview gate', () => {
    expect(shouldResumeAgentAfterImageWorkflow({
      kind: 'product_post', state: 'preview_confirm', status: 'active',
    })).toBe(true)
    expect(shouldResumeAgentAfterImageWorkflow({
      kind: 'creative', state: 'executed', status: 'done',
    })).toBe(false)
    expect(shouldResumeAgentAfterImageWorkflow({
      kind: 'product_post', state: 'rendering', status: 'waiting_worker',
    })).toBe(false)
    expect(shouldResumeAgentAfterImageWorkflow(null)).toBe(false)
  })
})
