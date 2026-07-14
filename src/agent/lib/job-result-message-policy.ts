/**
 * Jobs whose real result is delivered by the owner turn must not inject a
 * context-free assistant bubble from the worker callback.
 */
export function shouldEmitGenericJobSuccess(actionType: string): boolean {
  return actionType !== 'seo_audit'
}
