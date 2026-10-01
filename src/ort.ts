import * as ort from 'onnxruntime-web/webgpu'

import type { BackendId, ModelTask } from './config'

type GPUInfoLike = {
  description?: string
  device?: string
  vendor?: string
  architecture?: string
}

type GPUAdapterLike = {
  info?: GPUInfoLike
}

type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter(): Promise<GPUAdapterLike | null>
  }
}

export type BackendProbe = {
  id: BackendId
  available: boolean
  label: string
  detail: string
}

export type SegSession = {
  session: ort.InferenceSession
  provider: BackendId
  providerLabel: string
  inputName: string
  inputSize: number
}

type OverlayRegion = {
  score: number
  box: [number, number, number, number]
}

export type InferenceFrame = {
  task: ModelTask
  letterbox: {
    left: number
    top: number
    width: number
    height: number
    sourceWidth: number
    sourceHeight: number
  }
  regions: OverlayRegion[]
  mask?: ImageData
  crop?: { x: number; y: number; width: number; height: number }
  detections: number
  maxScore: number
  maxMaskProbability?: number
  inferenceMs: number
}

export type BenchmarkResult = {
  backend: BackendId
  label: string
  fps: number
  ms: number
  ok: boolean
  error?: string
}

let ortConfigured = false

function defaultWasmThreadCount(): number {
  const logical = navigator.hardwareConcurrency || 1
  return Math.min(4, Math.ceil(logical / 2))
}

function configureOrt() {
  if (ortConfigured) return
  ort.env.logLevel = 'error'
  const ortBase = new URL('/ort/', location.origin).href
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort-wasm-simd-threaded.asyncify.mjs', ortBase).href,
    wasm: new URL('ort-wasm-simd-threaded.asyncify.wasm', ortBase).href,
  }
  ort.env.wasm.numThreads = crossOriginIsolated ? 0 : 1
  ortConfigured = true
}

function gpuInfoLabel(info: GPUInfoLike | undefined): string {
  if (!info) return 'available'
  const preferred = [
    info.description,
    info.device,
    [info.vendor, info.architecture].filter(Boolean).join(' '),
  ].find((value) => value && value.trim())
  return preferred?.trim() || 'available'
}

export async function probeBackends(): Promise<BackendProbe[]> {
  const logical = navigator.hardwareConcurrency || 1
  const wasmDetail = crossOriginIsolated
    ? `ORT default: ${defaultWasmThreadCount()} of ${logical} logical threads`
    : 'single thread; cross-origin isolation unavailable'

  const probes: BackendProbe[] = [
    {
      id: 'wasm',
      available: true,
      label: `cpu / wasm (${wasmDetail})`,
      detail: wasmDetail,
    },
  ]

  const gpu = (navigator as NavigatorWithGpu).gpu
  if (!gpu) {
    probes.push({
      id: 'webgpu',
      available: false,
      label: 'webgpu (not available)',
      detail: 'WebGPU API unavailable',
    })
    return probes
  }

  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) {
      probes.push({
        id: 'webgpu',
        available: false,
        label: 'webgpu (not available)',
        detail: 'No GPU adapter returned',
      })
    } else {
      const detail = gpuInfoLabel(adapter.info)
      probes.push({
        id: 'webgpu',
        available: true,
        label: `webgpu (${detail})`,
        detail,
      })
    }
  } catch (error) {
    probes.push({
      id: 'webgpu',
      available: false,
      label: 'webgpu (not available)',
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  return probes
}

async function createSession(
  buffer: ArrayBuffer,
  backend: BackendId,
): Promise<ort.InferenceSession> {
  configureOrt()
  return ort.InferenceSession.create(buffer, {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
  })
}

export async function loadSession(
  buffer: ArrayBuffer,
  backend: BackendId,
  inputSize: number,
  probes?: BackendProbe[],
): Promise<SegSession> {
  const known = probes ?? (await probeBackends())
  const selected = known.find((item) => item.id === backend)
  if (selected && !selected.available) throw new Error(selected.label)

  const session = await createSession(buffer, backend)
  const providerLabel = selected?.label ?? backend
  return {
    session,
    provider: backend,
    providerLabel,
    inputName: session.inputNames[0],
    inputSize,
  }
}

type Detection = {
  score: number
  box: [number, number, number, number]
  coeff?: number[]
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value)
    return 1 / (1 + exp)
  }
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function parseDetectRows(
  data: Float32Array,
  dims: number[],
  objectThreshold: number,
): { regions: OverlayRegion[]; maxScore: number } {
  const candidates: OverlayRegion[] = []
  let maxScore = 0

  if (dims[2] === 6) {
    for (let row = 0; row < dims[1]; row++) {
      const offset = row * 6
      const score = data[offset + 4]
      maxScore = Math.max(maxScore, score)
      candidates.push({
        score,
        box: [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]],
      })
    }
  } else {
    const channels = dims[1]
    const anchors = dims[2]
    const classCount = channels - 4
    if (classCount < 1) return { regions: [], maxScore }

    for (let anchor = 0; anchor < anchors; anchor++) {
      let score = -Infinity
      for (let classIndex = 0; classIndex < classCount; classIndex++) {
        score = Math.max(score, data[(4 + classIndex) * anchors + anchor])
      }
      maxScore = Math.max(maxScore, score)
      const centerX = data[anchor]
      const centerY = data[anchors + anchor]
      const width = data[2 * anchors + anchor]
      const height = data[3 * anchors + anchor]
      candidates.push({
        score,
        box: [centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2],
      })
    }
  }

  return {
    regions: candidates
      .filter((detection) => detection.score >= objectThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16),
    maxScore,
  }
}

function parseSegmentRows(
  data: Float32Array,
  dims: number[],
  maskDim: number,
  objectThreshold: number,
): { detections: Detection[]; maxScore: number } {
  const candidates: Detection[] = []
  let maxScore = 0

  if (dims[2] === 6 + maskDim) {
    const rows = dims[1]
    const stride = dims[2]
    for (let row = 0; row < rows; row++) {
      const offset = row * stride
      const score = data[offset + 4]
      maxScore = Math.max(maxScore, score)
      const coeff = Array.from({ length: maskDim }, (_, channel) => data[offset + 6 + channel])
      candidates.push({
        score,
        box: [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]],
        coeff,
      })
    }
  } else {
    const channels = dims[1]
    const anchors = dims[2]
    const classCount = channels - 4 - maskDim
    if (classCount < 1) return { detections: [], maxScore }

    for (let anchor = 0; anchor < anchors; anchor++) {
      let score = -Infinity
      for (let classIndex = 0; classIndex < classCount; classIndex++) {
        score = Math.max(score, data[(4 + classIndex) * anchors + anchor])
      }
      maxScore = Math.max(maxScore, score)

      const centerX = data[anchor]
      const centerY = data[anchors + anchor]
      const width = data[2 * anchors + anchor]
      const height = data[3 * anchors + anchor]
      const coeff = Array.from(
        { length: maskDim },
        (_, channel) => data[(4 + classCount + channel) * anchors + anchor],
      )

      candidates.push({
        score,
        box: [centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2],
        coeff,
      })
    }
  }

  return {
    detections: candidates
      .filter((detection) => detection.score >= objectThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8),
    maxScore,
  }
}

export async function inferFrame(
  sessionInfo: SegSession,
  video: HTMLVideoElement,
  work: HTMLCanvasElement,
  task: ModelTask,
  maskThreshold: number,
  objectThreshold: number,
): Promise<InferenceFrame | null> {
  const size = sessionInfo.inputSize
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) return null

  work.width = size
  work.height = size
  const context = work.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  const gain = Math.min(size / sourceHeight, size / sourceWidth)
  const resizedWidth = Math.round(sourceWidth * gain)
  const resizedHeight = Math.round(sourceHeight * gain)
  const left = Math.round((size - resizedWidth) / 2 - 0.1)
  const top = Math.round((size - resizedHeight) / 2 - 0.1)

  context.fillStyle = 'rgb(114,114,114)'
  context.fillRect(0, 0, size, size)
  context.drawImage(video, 0, 0, sourceWidth, sourceHeight, left, top, resizedWidth, resizedHeight)

  const pixels = context.getImageData(0, 0, size, size).data
  const chw = new Float32Array(3 * size * size)
  const area = size * size
  for (let index = 0; index < area; index++) {
    chw[index] = pixels[index * 4] / 255
    chw[area + index] = pixels[index * 4 + 1] / 255
    chw[2 * area + index] = pixels[index * 4 + 2] / 255
  }

  const started = performance.now()
  const outputs = await sessionInfo.session.run({
    [sessionInfo.inputName]: new ort.Tensor('float32', chw, [1, 3, size, size]),
  })
  const inferenceMs = performance.now() - started

  const outputTensors = sessionInfo.session.outputNames
    .map((name) => outputs[name])
    .filter((tensor): tensor is ort.Tensor => !!tensor)
  const pred = outputTensors.find((tensor) => tensor.dims.length === 3)
  if (!pred) return null

  const predictionData = pred.data as Float32Array
  const predictionDims = pred.dims.map(Number)
  const letterbox = {
    left,
    top,
    width: resizedWidth,
    height: resizedHeight,
    sourceWidth,
    sourceHeight,
  }

  if (task === 'detect') {
    const parsed = parseDetectRows(predictionData, predictionDims, objectThreshold)
    return {
      task,
      letterbox,
      regions: parsed.regions,
      detections: parsed.regions.length,
      maxScore: parsed.maxScore,
      inferenceMs,
    }
  }

  const proto = outputTensors.find((tensor) => tensor.dims.length === 4)
  if (!proto) return null
  const protoData = proto.data as Float32Array
  const protoDims = proto.dims.map(Number)
  const maskDim = protoDims[1]
  const maskHeight = protoDims[2]
  const maskWidth = protoDims[3]
  const parsed = parseSegmentRows(predictionData, predictionDims, maskDim, objectThreshold)
  const image = new ImageData(maskWidth, maskHeight)
  const xScale = maskWidth / size
  const yScale = maskHeight / size
  let maxMaskProbability = 0

  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      let probability = 0

      for (const detection of parsed.detections) {
        const x1 = detection.box[0] * xScale
        const y1 = detection.box[1] * yScale
        const x2 = detection.box[2] * xScale
        const y2 = detection.box[3] * yScale
        if (x < x1 || x > x2 || y < y1 || y > y2) continue

        let logit = 0
        for (let channel = 0; channel < maskDim; channel++) {
          logit +=
            (detection.coeff?.[channel] ?? 0) *
            protoData[channel * maskHeight * maskWidth + y * maskWidth + x]
        }
        probability = Math.max(probability, sigmoid(logit))
      }

      maxMaskProbability = Math.max(maxMaskProbability, probability)
      const offset = (y * maskWidth + x) * 4
      image.data[offset] = 0
      image.data[offset + 1] = 220
      image.data[offset + 2] = 165
      image.data[offset + 3] = probability >= maskThreshold ? Math.round(220 * probability) : 0
    }
  }

  const regions = parsed.detections.map((detection) => ({
    score: detection.score,
    box: detection.box,
  }))

  return {
    task,
    letterbox,
    regions,
    mask: image,
    crop: {
      x: (left * maskWidth) / size,
      y: (top * maskHeight) / size,
      width: (resizedWidth * maskWidth) / size,
      height: (resizedHeight * maskHeight) / size,
    },
    detections: regions.length,
    maxScore: parsed.maxScore,
    maxMaskProbability,
    inferenceMs,
  }
}

function randomTensor(size: number): Float32Array {
  const data = new Float32Array(3 * size * size)
  for (let index = 0; index < data.length; index++) data[index] = Math.random()
  return data
}

export async function benchmarkModel(
  buffer: ArrayBuffer,
  inputSize: number,
  probes: BackendProbe[],
  onBackend?: (label: string) => void,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = []
  const data = randomTensor(inputSize)

  for (const probe of probes.filter((item) => item.available)) {
    onBackend?.(probe.label)
    let session: ort.InferenceSession | null = null
    try {
      session = await createSession(buffer.slice(0), probe.id)
      const inputName = session.inputNames[0]
      const tensor = new ort.Tensor('float32', data, [1, 3, inputSize, inputSize])
      await session.run({ [inputName]: tensor })

      const runs = 5
      const started = performance.now()
      for (let run = 0; run < runs; run++) {
        await session.run({ [inputName]: tensor })
      }
      const elapsed = performance.now() - started
      const ms = elapsed / runs
      results.push({
        backend: probe.id,
        label: probe.label,
        fps: 1000 / ms,
        ms,
        ok: true,
      })
    } catch (error) {
      results.push({
        backend: probe.id,
        label: probe.label,
        fps: 0,
        ms: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await session?.release()
    }
  }

  return results
}
