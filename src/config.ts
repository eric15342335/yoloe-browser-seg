import appConfig from '../app.config.json'

declare const modelIdBrand: unique symbol

export type ModelId = string & { readonly [modelIdBrand]: true }
export type ModelTask = 'detect' | 'segment'
export type BackendId = 'wasm' | 'webgpu'
export type CameraMode = 'max' | '1080p' | '720p' | '480p'

type ModelSpec = {
  id: ModelId
  label: string
  task: ModelTask
  checkpoint: string
  yaml?: string
}

export const APP_VERSION = appConfig.version
export const DEFAULT_MODEL = appConfig.defaultModel as ModelId
export const DEFAULT_PROCESSING_SIZE = appConfig.defaultProcessingSize
export const MODELS: ReadonlyArray<ModelSpec> = appConfig.models.map((model) => ({
  id: model.id as ModelId,
  label: model.label,
  task: model.task as ModelTask,
  checkpoint: model.checkpoint,
  ...('yaml' in model ? { yaml: model.yaml } : {}),
}))
export const PROCESSING_SIZES = appConfig.processingSizes

export const CAMERA_MODES: ReadonlyArray<{ id: CameraMode; label: string }> = [
  { id: 'max', label: 'Maximum available' },
  { id: '1080p', label: '1920 × 1080' },
  { id: '720p', label: '1280 × 720' },
  { id: '480p', label: '640 × 480' },
]

function modelSpec(id: ModelId): ModelSpec {
  return MODELS.find((model) => model.id === id) ?? MODELS[0]
}

export function isModelId(value: string): value is ModelId {
  return MODELS.some((model) => model.id === value)
}

export function isProcessingSize(value: number): boolean {
  return PROCESSING_SIZES.includes(value)
}

export function modelLabel(id: ModelId): string {
  const spec = modelSpec(id)
  const fullName = spec.task === 'segment' ? spec.checkpoint : spec.id
  return `${spec.label} · ${fullName}`
}

export function modelTask(id: ModelId): ModelTask {
  return modelSpec(id).task
}

export function cameraConstraints(mode: CameraMode): MediaTrackConstraints {
  if (mode === '1080p') return { width: { ideal: 1920 }, height: { ideal: 1080 } }
  if (mode === '720p') return { width: { ideal: 1280 }, height: { ideal: 720 } }
  if (mode === '480p') return { width: { ideal: 640 }, height: { ideal: 480 } }
  return { width: { ideal: 4096 }, height: { ideal: 2160 } }
}
