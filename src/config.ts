export type ModelId =
  | 'yoloe-26n'
  | 'yoloe-26s'
  | 'yoloe-26m'
  | 'yoloe-26l'
  | 'yoloe-26x'
  | 'yoloe-26n-seg.pt'
  | 'yoloe-26s-seg.pt'
  | 'yoloe-26m-seg.pt'
  | 'yoloe-26l-seg.pt'
  | 'yoloe-26x-seg.pt'

export type ModelTask = 'detect' | 'segment'
export type BackendId = 'wasm' | 'webgpu'
export type CameraMode = 'max' | '1080p' | '720p' | '480p'

export const MODELS: ReadonlyArray<{
  id: ModelId
  label: string
  task: ModelTask
  checkpoint: string
}> = [
  {
    id: 'yoloe-26n',
    label: 'YOLOE-26n Object Localization',
    task: 'detect',
    checkpoint: 'yoloe-26n-seg.pt',
  },
  {
    id: 'yoloe-26s',
    label: 'YOLOE-26s Object Localization',
    task: 'detect',
    checkpoint: 'yoloe-26s-seg.pt',
  },
  {
    id: 'yoloe-26m',
    label: 'YOLOE-26m Object Localization',
    task: 'detect',
    checkpoint: 'yoloe-26m-seg.pt',
  },
  {
    id: 'yoloe-26l',
    label: 'YOLOE-26l Object Localization',
    task: 'detect',
    checkpoint: 'yoloe-26l-seg.pt',
  },
  {
    id: 'yoloe-26x',
    label: 'YOLOE-26x Object Localization',
    task: 'detect',
    checkpoint: 'yoloe-26x-seg.pt',
  },
  {
    id: 'yoloe-26n-seg.pt',
    label: 'YOLOE-26n Segmentation',
    task: 'segment',
    checkpoint: 'yoloe-26n-seg.pt',
  },
  {
    id: 'yoloe-26s-seg.pt',
    label: 'YOLOE-26s Segmentation',
    task: 'segment',
    checkpoint: 'yoloe-26s-seg.pt',
  },
  {
    id: 'yoloe-26m-seg.pt',
    label: 'YOLOE-26m Segmentation',
    task: 'segment',
    checkpoint: 'yoloe-26m-seg.pt',
  },
  {
    id: 'yoloe-26l-seg.pt',
    label: 'YOLOE-26l Segmentation',
    task: 'segment',
    checkpoint: 'yoloe-26l-seg.pt',
  },
  {
    id: 'yoloe-26x-seg.pt',
    label: 'YOLOE-26x Segmentation',
    task: 'segment',
    checkpoint: 'yoloe-26x-seg.pt',
  },
]

export const PROCESSING_SIZES = [256, 320, 416, 512, 640] as const

export const CAMERA_MODES: ReadonlyArray<{ id: CameraMode; label: string }> = [
  { id: 'max', label: 'Maximum available' },
  { id: '1080p', label: '1920 × 1080' },
  { id: '720p', label: '1280 × 720' },
  { id: '480p', label: '640 × 480' },
]

function modelSpec(id: ModelId) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0]
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
