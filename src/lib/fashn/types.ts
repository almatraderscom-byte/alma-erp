export type FashnModelName =
  | 'tryon-max'
  | 'product-to-model'
  | 'model-swap'
  | 'face-to-model'
  | 'edit'
  | 'background-remove'

export type FashnResolution = '1k' | '2k' | '4k'
export type FashnGenerationMode = 'fast' | 'balanced' | 'quality'

export type FashnRunResponse = {
  id: string
  error: string | null
}

export type FashnStatusResponse = {
  id: string
  status: 'starting' | 'processing' | 'completed' | 'failed'
  output?: string[]
  error?: string | null
}

export type FashnRunOptions = {
  resolution?: FashnResolution
  generationMode?: FashnGenerationMode
  prompt?: string
  numImages?: number
  outputFormat?: 'png' | 'jpeg'
  returnBase64?: boolean
  faceReference?: string
}
