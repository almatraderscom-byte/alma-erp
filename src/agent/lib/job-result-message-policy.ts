/**
 * Jobs whose real result is delivered by the owner turn must not inject a
 * context-free assistant bubble from the worker callback.
 */
export function shouldEmitGenericJobSuccess(actionType: string): boolean {
  return actionType !== 'seo_audit'
}

/** SEO worker success is intermediate; report delivery must resume the head. */
export function shouldResumeAgentAfterJob(actionType: string, status: 'success' | 'failed'): boolean {
  return actionType === 'seo_audit' && status === 'success'
}

/**
 * A generated image is already delivered by the callback as durable file_ref
 * blocks. Resume the head only when that image is the creative step of an
 * existing product-post workflow; standalone image requests must settle there
 * instead of inventing a preview-confirm/final-choice question.
 */
export function shouldResumeAgentAfterImageWorkflow(run: {
  kind: string
  state: string
  status: string
} | null | undefined): boolean {
  return run?.kind === 'product_post'
    && run.state === 'preview_confirm'
    && run.status === 'active'
}
