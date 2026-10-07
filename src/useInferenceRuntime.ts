import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { modelLabel, type BackendId, type ModelTask } from './config'
import type { AppEvent, LoadedModel } from './machine'
import {
  benchmarkModel,
  inferFrame,
  loadSession,
  probeBackends,
  type BackendProbe,
  type BenchmarkResult,
  type InferenceFrame,
  type SegSession,
} from './ort'

type Send = (event: AppEvent) => void

type Options = {
  isLoading: boolean
  isRunning: boolean
  model: LoadedModel | null
  activeTask: ModelTask
  backend: BackendId
  maskThreshold: number
  objectThreshold: number
  videoRef: RefObject<HTMLVideoElement | null>
  overlayRef: RefObject<HTMLCanvasElement | null>
  send: Send
}

function drawInference(
  result: InferenceFrame,
  video: HTMLVideoElement,
  overlay: HTMLCanvasElement,
  work: HTMLCanvasElement,
) {
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight

  const context = overlay.getContext('2d')
  if (!context) return

  context.clearRect(0, 0, overlay.width, overlay.height)
  context.imageSmoothingEnabled = true

  if (result.task === 'segment' && result.mask && result.crop) {
    work.width = result.mask.width
    work.height = result.mask.height
    const workContext = work.getContext('2d')
    if (!workContext) return
    workContext.putImageData(result.mask, 0, 0)
    context.drawImage(
      work,
      result.crop.x,
      result.crop.y,
      result.crop.width,
      result.crop.height,
      0,
      0,
      overlay.width,
      overlay.height,
    )
    return
  }

  const mapPoint = (x: number, y: number) => ({
    x: ((x - result.letterbox.left) / result.letterbox.width) * overlay.width,
    y: ((y - result.letterbox.top) / result.letterbox.height) * overlay.height,
  })

  context.strokeStyle = '#00dcaa'
  context.fillStyle = '#00dcaa'
  context.lineWidth = Math.max(2, overlay.width / 640)
  context.font = `600 ${Math.max(12, overlay.width / 110)}px Inter, sans-serif`

  for (const region of result.regions) {
    const first = mapPoint(region.box[0], region.box[1])
    const second = mapPoint(region.box[2], region.box[3])
    const x = Math.max(0, Math.min(first.x, second.x))
    const y = Math.max(0, Math.min(first.y, second.y))
    const right = Math.min(overlay.width, Math.max(first.x, second.x))
    const bottom = Math.min(overlay.height, Math.max(first.y, second.y))
    const width = right - x
    const height = bottom - y
    if (width <= 0 || height <= 0) continue

    context.strokeRect(x, y, width, height)
    context.fillText(region.score.toFixed(3), x + context.lineWidth, Math.max(16, y - 6))
  }
}

export function useInferenceRuntime({
  isLoading,
  isRunning,
  model,
  activeTask,
  backend,
  maskThreshold,
  objectThreshold,
  videoRef,
  overlayRef,
  send,
}: Options) {
  const workRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<SegSession | null>(null)
  const rafRef = useRef<number | null>(null)
  const busyRef = useRef(false)
  const fpsEmaRef = useRef(0)
  const lastStatsUpdateRef = useRef(0)

  const [backendProbes, setBackendProbes] = useState<BackendProbe[]>([])
  const [providerLabel, setProviderLabel] = useState('')
  const [fps, setFps] = useState(0)
  const [diagnostics, setDiagnostics] = useState<{
    detections: number
    maxScore: number
    maxMaskProbability?: number
    inferenceMs: number
  } | null>(null)
  const [benchmarking, setBenchmarking] = useState(false)
  const [benchmarkLabel, setBenchmarkLabel] = useState('')
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([])

  const selectedBackendLabel = useMemo(
    () =>
      backendProbes.find((item) => item.id === backend)?.label ??
      (backend === 'wasm' ? 'cpu / wasm' : backend),
    [backend, backendProbes],
  )

  const releaseSession = useCallback(async () => {
    const current = sessionRef.current
    sessionRef.current = null
    if (current) await current.session.release()
  }, [])

  useEffect(() => {
    let active = true

    const probe = async () => {
      try {
        const probes = await probeBackends()
        if (active) setBackendProbes(probes)
      } catch (error) {
        console.error('Backend probe failed', error)
      }
    }

    void probe()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!isLoading || !model) return

    if (!backendProbes.length) return

    let cancelled = false

    const run = async () => {
      // Guarantee the loading state paints before session initialization begins.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (cancelled) return

      fpsEmaRef.current = 0
      lastStatsUpdateRef.current = 0
      setFps(0)
      setDiagnostics(null)
      setBenchmarkLabel('')
      setBenchmarkResults([])

      await releaseSession()
      if (cancelled) return

      const session = await loadSession(model.buffer, backend, model.inputSize, backendProbes)
      if (cancelled) {
        await session.session.release()
        return
      }

      sessionRef.current = session
      setProviderLabel(session.providerLabel)
      fpsEmaRef.current = 0
      lastStatsUpdateRef.current = 0
      setFps(0)
      setDiagnostics(null)
      send({ type: 'MODEL_READY' })
    }

    run().catch((error) => {
      if (!cancelled) {
        send({
          type: 'FAIL',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [backend, backendProbes, isLoading, model, releaseSession, send])

  useEffect(() => {
    if (isLoading || isRunning) return
    void releaseSession()
  }, [isLoading, isRunning, releaseSession])

  useEffect(
    () => () => {
      void releaseSession()
    },
    [releaseSession],
  )

  useEffect(() => {
    if (!isRunning || !model) return

    let cancelled = false

    const tick = async () => {
      if (cancelled) return

      const video = videoRef.current
      const work = workRef.current
      const overlay = overlayRef.current
      const session = sessionRef.current

      if (
        !benchmarking &&
        !busyRef.current &&
        video &&
        work &&
        overlay &&
        session &&
        video.readyState >= 2
      ) {
        busyRef.current = true
        try {
          const frameStarted = performance.now()
          const result = await inferFrame(
            session,
            video,
            work,
            activeTask,
            maskThreshold,
            objectThreshold,
          )
          if (cancelled) return

          if (result) {
            const frameMs = performance.now() - frameStarted
            const instantaneousFps = 1000 / Math.max(1, frameMs)
            fpsEmaRef.current = fpsEmaRef.current
              ? fpsEmaRef.current * 0.8 + instantaneousFps * 0.2
              : instantaneousFps

            const now = performance.now()
            if (now - lastStatsUpdateRef.current >= 250) {
              lastStatsUpdateRef.current = now
              setFps(fpsEmaRef.current)
              setDiagnostics({
                detections: result.detections,
                maxScore: result.maxScore,
                maxMaskProbability: result.maxMaskProbability,
                inferenceMs: result.inferenceMs,
              })
            }

            drawInference(result, video, overlay, work)
          }
        } catch (error) {
          if (!cancelled) {
            console.error('Local inference failed', error)
            send({
              type: 'FAIL',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          return
        } finally {
          busyRef.current = false
        }
      }

      if (!cancelled) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [
    activeTask,
    benchmarking,
    isRunning,
    maskThreshold,
    model,
    objectThreshold,
    overlayRef,
    send,
    videoRef,
  ])

  const resetRuntime = useCallback(() => {
    void releaseSession()
    fpsEmaRef.current = 0
    lastStatsUpdateRef.current = 0
    setProviderLabel('')
    setFps(0)
    setDiagnostics(null)
    setBenchmarking(false)
    setBenchmarkLabel('')
    setBenchmarkResults([])

    const overlay = overlayRef.current
    const context = overlay?.getContext('2d')
    if (overlay && context) context.clearRect(0, 0, overlay.width, overlay.height)
  }, [overlayRef, releaseSession])

  const loadingMessage = model
    ? `Model exported. Initializing ${modelLabel(model.modelName)} at ${model.inputSize}×${model.inputSize} with ${selectedBackendLabel}. Realtime ${activeTask === 'segment' ? 'segmentation' : 'localization'} starts automatically when ready.`
    : ''

  const runBenchmark = useCallback(async () => {
    if (!model || benchmarking || !backendProbes.length) return

    setBenchmarking(true)
    setBenchmarkResults([])

    try {
      const results = await benchmarkModel(
        model.buffer.slice(0),
        model.inputSize,
        backendProbes,
        (label) => setBenchmarkLabel(`Benchmarking ${label}…`),
      )
      setBenchmarkResults(results)
      setBenchmarkLabel('')
    } catch (error) {
      console.error('Benchmark failed', error)
      setBenchmarkLabel(error instanceof Error ? error.message : String(error))
    } finally {
      setBenchmarking(false)
    }
  }, [backendProbes, benchmarking, model])

  return {
    workRef,
    backendProbes,
    selectedBackendLabel,
    providerLabel,
    fps,
    diagnostics,
    loadingMessage,
    benchmarking,
    benchmarkLabel,
    benchmarkResults,
    runBenchmark,
    resetRuntime,
  }
}
