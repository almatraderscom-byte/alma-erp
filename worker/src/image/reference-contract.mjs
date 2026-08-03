export const ALLOWED_GENERIC_IMAGE_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gpt-image-2',
  'seedream-5.0-pro',
]

export function assertGenericImageModel(model) {
  if (!ALLOWED_GENERIC_IMAGE_MODELS.includes(model)) {
    throw new Error(`generic image model not allowlisted: ${model}`)
  }
  return model
}

export function genericProviderForModel(model) {
  assertGenericImageModel(model)
  if (model.startsWith('gpt-image')) return 'openai'
  if (model.startsWith('seedream')) return 'fal'
  return 'gemini'
}

/**
 * Validate an adapter's immutable model + ordered role/path bindings before it
 * loads references or submits a paid request. Adapters that use named,
 * unordered provider fields (direct FASHN) keep their field-aware validator.
 */
export function validateOrderedReferenceContract(contract, {
  actualModel,
  bindings,
} = {}) {
  if (!contract) return []
  if (contract.actualModel && actualModel && contract.actualModel !== actualModel) {
    throw new Error(`reference model snapshot mismatch: expected ${contract.actualModel}, queued ${actualModel}`)
  }
  const contractBindings = Array.isArray(contract.bindings) ? contract.bindings : []
  const expectedBindings = Array.isArray(bindings) ? bindings : []
  if (contractBindings.length !== expectedBindings.length) {
    throw new Error(`reference contract mismatch: expected ${contractBindings.length}, queued ${expectedBindings.length}`)
  }
  for (let i = 0; i < contractBindings.length; i++) {
    const contractBinding = contractBindings[i]
    const expectedBinding = expectedBindings[i]
    if (contractBinding?.role !== expectedBinding?.role || contractBinding?.path !== expectedBinding?.path) {
      throw new Error(`reference contract order mismatch at ${i + 1}`)
    }
    if (contractBinding.required && !contractBinding.path) {
      throw new Error(`required reference unavailable: ${contractBinding.role}`)
    }
  }
  return contractBindings
}

export function requiredReferencePaths(payload) {
  const arrayPaths = Array.isArray(payload?.referenceImageIds)
    ? payload.referenceImageIds
    : null
  const paths = (arrayPaths ?? [payload?.referenceImageId, payload?.secondReferenceImageId])
    .filter((path) => typeof path === 'string' && path.trim())
  if (paths.length > 3) throw new Error(`reference limit exceeded: ${paths.length}`)
  const bindings = Array.isArray(payload?.referenceContract?.bindings)
    ? payload.referenceContract.bindings
    : null
  if (bindings) {
    if (bindings.length !== paths.length) {
      throw new Error(`reference contract mismatch: expected ${bindings.length}, queued ${paths.length}`)
    }
    for (let i = 0; i < bindings.length; i++) {
      if (bindings[i]?.path !== paths[i]) {
        throw new Error(`reference contract order mismatch at ${i + 1}`)
      }
    }
  }
  return paths
}

export async function loadRequiredReferenceParts(paths, loader) {
  const parts = []
  for (const path of paths) {
    const part = await loader(path)
    if (!part) throw new Error(`required reference unavailable: ${path}`)
    parts.push(part)
  }
  if (parts.length !== paths.length) {
    throw new Error(`required reference transport mismatch: expected ${paths.length}, sent ${parts.length}`)
  }
  return parts
}

export function makeContractReferenceReceipt(contract, sentCount, fallbackCount = 0) {
  const bindings = Array.isArray(contract?.bindings) ? contract.bindings : []
  const expectedCount = bindings.length || fallbackCount
  if (sentCount !== expectedCount) {
    throw new Error(`required reference transport mismatch: expected ${expectedCount}, sent ${sentCount}`)
  }
  return {
    version: 1,
    expectedCount,
    sentCount,
    roles: bindings.map((binding) => binding.role),
    sources: bindings.map((binding) => binding.source),
    allRequiredSent: bindings.every((binding) => !binding.required || Boolean(binding.path)),
  }
}

export function makeReferenceReceipt(payload, sentCount) {
  return makeContractReferenceReceipt(
    payload?.referenceContract,
    sentCount,
    requiredReferencePaths(payload).length,
  )
}
