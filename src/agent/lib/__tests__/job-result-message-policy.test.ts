import { describe, expect, it } from 'vitest'
import { shouldEmitGenericJobSuccess, shouldResumeAgentAfterJob } from '@/agent/lib/job-result-message-policy'

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
})
