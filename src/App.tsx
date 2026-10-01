import { useMachine } from '@xstate/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  CAMERA_MODES,
  MODELS,
  PROCESSING_SIZES,
  cameraConstraints,
  modelLabel,
  modelTask,
  type BackendId,
  type CameraMode,
  type ModelId,
} from './config'
import { appMachine, type Point } from './machine'
import { appAssetUrls, connectOfflineWorker, type OfflineClient } from './offline'
import {
  benchmarkModel,
  loadSession,
  probeBackends,
  inferFrame,
  type BackendProbe,
  type BenchmarkResult,
  type SegSession,
} from './ort'

const API = '/api/export'
const APP_VERSION = '12'

type FrameSize = { width: number; height: number }

function pointDistance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0
  let area = 0
  for (let index = 0; index < points.length; index++) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area) / 2
}

function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>): Point {
  const canvas = event.currentTarget
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) * canvas.width) / rect.width,
    y: ((event.clientY - rect.top) * canvas.height) / rect.height,
  }
}

function compactPoints(points: Point[], limit = 256): Point[] {
  if (points.length <= limit) return points
  const step = Math.ceil(points.length / limit)
  const compacted = points.filter((_, index) => index % step === 0)
  if (compacted[compacted.length - 1] !== points[points.length - 1]) {
    compacted.push(points[points.length - 1])
  }
  return compacted
}

export default function App() {
  const [state, send] = useMachine(appMachine)
  const videoRef = useRef<HTMLVideoElement>(null)
  const captureCanvas = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const workRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sessionRef = useRef<SegSession | null>(null)
  const rafRef = useRef<number | null>(null)
  const busyRef = useRef(false)
  const drawPointsRef = useRef<Point[]>([])
  const drawingRef = useRef(false)
  const fpsEmaRef = useRef(0)
  const lastStatsUpdateRef = useRef(0)
  const offlineRef = useRef<OfflineClient | null>(null)

  const [promptValid, setPromptValid] = useState(false)
  const [promptMessage, setPromptMessage] = useState(
    'Draw a closed loop and finish near the start point.',
  )

  const [modelName, setModelName] = useState<ModelId>('yoloe-26n')
  const [activeModelName, setActiveModelName] = useState<ModelId>('yoloe-26n')
  const [processingSize, setProcessingSize] = useState(320)
  const [activeInputSize, setActiveInputSize] = useState(320)
  const [cameraMode, setCameraMode] = useState<CameraMode>('max')
  const [backend, setBackend] = useState<BackendId>('wasm')
  const [backendProbes, setBackendProbes] = useState<BackendProbe[]>([])
  const [maskThreshold, setMaskThreshold] = useState(0.5)
  const [objectThreshold, setObjectThreshold] = useState(0.01)

  const [providerLabel, setProviderLabel] = useState('')
  const [cameraSize, setCameraSize] = useState<FrameSize | null>(null)
  const [fps, setFps] = useState(0)
  const [diagnostics, setDiagnostics] = useState<{
    detections: number
    maxScore: number
    maxMaskProbability?: number
    inferenceMs: number
  } | null>(null)

  const [loadingMessage, setLoadingMessage] = useState('')
  const [modelBytes, setModelBytes] = useState(0)

  const [benchmarking, setBenchmarking] = useState(false)
  const [benchmarkLabel, setBenchmarkLabel] = useState('')
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([])

  const [offlineReady, setOfflineReady] = useState(false)
  const [savedModelAvailable, setSavedModelAvailable] = useState(false)
  const [offlineStatus, setOfflineStatus] = useState('')

  const stage = state.value as string

  const selectedBackendLabel = useMemo(
    () =>
      backendProbes.find((item) => item.id === backend)?.label ??
      (backend === 'wasm' ? 'cpu / wasm' : backend),
    [backend, backendProbes],
  )

  const selectedTask = modelTask(modelName)
  const activeTask = modelTask(activeModelName)

  const viewportAspect = cameraSize ? `${cameraSize.width} / ${cameraSize.height}` : '16 / 9'

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    stopCamera()
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(cameraMode),
      audio: false,
    })
    const track = stream.getVideoTracks()[0]

    if (cameraMode === 'max' && track) {
      const capabilities = track.getCapabilities()
      const maxWidth = capabilities.width?.max
      const maxHeight = capabilities.height?.max
      if (maxWidth && maxHeight) {
        try {
          await track.applyConstraints({
            width: { ideal: maxWidth },
            height: { ideal: maxHeight },
          })
        } catch {
          // Keep the browser-selected high-resolution stream.
        }
      }
    }

    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      const settings = track?.getSettings()
      setCameraSize({
        width: settings?.width ?? videoRef.current.videoWidth,
        height: settings?.height ?? videoRef.current.videoHeight,
      })
    }
  }, [cameraMode, stopCamera])

  useEffect(() => {
    if (stage !== 'camera' && stage !== 'running') {
      stopCamera()
      return
    }

    let cancelled = false
    startCamera().catch((error) => {
      if (!cancelled) send({ type: 'FAIL', message: String(error) })
    })
    return () => {
      cancelled = true
      stopCamera()
    }
  }, [stage, startCamera, stopCamera, send])

  useEffect(
    () => () => {
      stopCamera()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      void sessionRef.current?.session.release()
    },
    [stopCamera],
  )

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

    const connectOffline = async () => {
      try {
        const client = await connectOfflineWorker()
        if (!active || !client) return
        offlineRef.current = client
        setOfflineReady(true)
        setSavedModelAvailable(await client.hasModel())
      } catch (error) {
        console.warn('Offline worker unavailable', error)
      }
    }

    void probe()
    void connectOffline()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const checkVersion = async () => {
      if (!navigator.onLine) return
      try {
        const response = await fetch('/api/version', { cache: 'no-store' })
        if (!response.ok) return
        const data = (await response.json()) as { version?: string }
        if (data.version && data.version !== APP_VERSION) location.reload()
      } catch {
        // Offline mode intentionally has no version endpoint.
      }
    }

    void checkVersion()
    const id = window.setInterval(checkVersion, 15000)
    return () => window.clearInterval(id)
  }, [])

  async function capture() {
    const video = videoRef.current
    const canvas = captureCanvas.current
    const overlay = overlayRef.current
    if (!video || !canvas || !video.videoWidth) return

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    if (overlay) {
      overlay.width = video.videoWidth
      overlay.height = video.videoHeight
    }
    canvas.getContext('2d')!.drawImage(video, 0, 0)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    })
    if (!blob) return

    setCameraSize({ width: video.videoWidth, height: video.videoHeight })
    stopCamera()
    drawPointsRef.current = []
    setPromptValid(false)
    setPromptMessage('Draw a closed loop and finish near the start point.')
    send({ type: 'CAPTURED', blob })
  }

  function redrawSelection(points: Point[], mode: 'drawing' | 'valid' | 'invalid', rawEnd?: Point) {
    const canvas = overlayRef.current
    const base = captureCanvas.current
    if (!canvas || !base) return

    canvas.width = base.width
    canvas.height = base.height
    const context = canvas.getContext('2d')!
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (!points.length) return

    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) context.lineTo(point.x, point.y)

    if (mode === 'valid') context.closePath()
    context.lineWidth = Math.max(3, canvas.width / 360)
    context.lineJoin = 'round'
    context.lineCap = 'round'

    if (mode === 'drawing') {
      context.strokeStyle = '#ffffff'
      context.stroke()
    } else if (mode === 'invalid') {
      context.strokeStyle = '#ff4d4f'
      context.stroke()
    } else {
      context.fillStyle = 'rgba(0, 200, 150, 0.20)'
      context.strokeStyle = '#00c896'
      context.fill()
      context.stroke()

      if (rawEnd && pointDistance(rawEnd, points[0]) > 1) {
        context.save()
        context.setLineDash([10, 8])
        context.strokeStyle = '#f59e0b'
        context.beginPath()
        context.moveTo(rawEnd.x, rawEnd.y)
        context.lineTo(points[0].x, points[0].y)
        context.stroke()
        context.restore()
      }
    }

    const radius = Math.max(5, canvas.width / 220)
    context.fillStyle = mode === 'invalid' ? '#ff4d4f' : '#00c896'
    context.beginPath()
    context.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2)
    context.fill()
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (stage !== 'prompt') return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = canvasPoint(event)
    drawPointsRef.current = [point]
    drawingRef.current = true
    setPromptValid(false)
    setPromptMessage('Keep drawing. Finish near the green start point.')
    send({ type: 'POLYGON', points: [] })
    redrawSelection([point], 'drawing')
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || stage !== 'prompt') return
    const point = canvasPoint(event)
    const points = drawPointsRef.current
    const previous = points[points.length - 1]
    const minimumStep = Math.max(2, event.currentTarget.width / 640)
    if (previous && pointDistance(previous, point) < minimumStep) return
    points.push(point)
    redrawSelection(points, 'drawing')
  }

  function pointerUp() {
    if (!drawingRef.current || stage !== 'prompt') return
    drawingRef.current = false

    const canvas = overlayRef.current
    if (!canvas) return
    const raw = compactPoints(drawPointsRef.current)
    if (raw.length < 6) {
      setPromptValid(false)
      setPromptMessage('Region rejected: draw a loop, not a short line.')
      send({ type: 'POLYGON', points: [] })
      redrawSelection(raw, 'invalid')
      return
    }

    const first = raw[0]
    const rawEnd = raw[raw.length - 1]
    const closeLimit = Math.max(18, Math.min(canvas.width, canvas.height) * 0.08)
    const closeDistance = pointDistance(first, rawEnd)
    const area = polygonArea(raw)
    const minimumArea = canvas.width * canvas.height * 0.002

    if (closeDistance > closeLimit) {
      setPromptValid(false)
      setPromptMessage(
        `Region rejected: endpoint is ${Math.round(closeDistance)} px from start. Close the loop.`,
      )
      send({ type: 'POLYGON', points: [] })
      redrawSelection(raw, 'invalid')
      return
    }

    if (area < minimumArea) {
      setPromptValid(false)
      setPromptMessage('Region rejected: enclosed area is too small.')
      send({ type: 'POLYGON', points: [] })
      redrawSelection(raw, 'invalid')
      return
    }

    const processed = [...raw.slice(0, -1), first]
    drawPointsRef.current = processed
    setPromptValid(true)
    setPromptMessage(
      `Closed region ready. Endpoint snapped by ${Math.round(closeDistance)} px; filled preview is the exact prompt mask.`,
    )
    send({ type: 'POLYGON', points: processed })
    redrawSelection(processed, 'valid', rawEnd)
  }

  async function exportModel() {
    if (
      !state.context.capture ||
      !promptValid ||
      state.context.polygon.length < 3 ||
      !captureCanvas.current
    )
      return

    setActiveModelName(modelName)
    setActiveInputSize(processingSize)
    setBenchmarkResults([])
    send({ type: 'EXPORT' })

    try {
      const form = new FormData()
      form.append('image', state.context.capture, 'capture.jpg')
      form.append('polygon', JSON.stringify(state.context.polygon))
      form.append('width', String(captureCanvas.current.width))
      form.append('height', String(captureCanvas.current.height))
      form.append('model_name', modelName)
      form.append('imgsz', String(processingSize))

      const response = await fetch(API, { method: 'POST', body: form })
      if (!response.ok) throw new Error(await response.text())
      const model = await response.arrayBuffer()
      setModelBytes(model.byteLength)
      setLoadingMessage(
        `Model exported. Initializing ${modelLabel(modelName)} locally with ${selectedBackendLabel}.`,
      )
      send({ type: 'EXPORTED', model })
    } catch (error) {
      send({
        type: 'FAIL',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  useEffect(() => {
    if (stage !== 'loading' || !state.context.model) return
    const modelBuffer = state.context.model

    let cancelled = false
    const run = async () => {
      let probes = backendProbes
      if (!probes.length) {
        probes = await probeBackends()
        if (!cancelled) setBackendProbes(probes)
      }

      setLoadingMessage(
        `Model exported. Initializing ${modelLabel(activeModelName)} at ${activeInputSize}×${activeInputSize} with ${selectedBackendLabel}. Realtime ${activeTask === 'segment' ? 'segmentation' : 'localization'} starts automatically when ready.`,
      )

      // Guarantee the loading state paints before session initialization begins.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

      if (sessionRef.current) {
        await sessionRef.current.session.release()
        sessionRef.current = null
      }

      const session = await loadSession(modelBuffer, backend, activeInputSize, probes)
      if (cancelled) {
        await session.session.release()
        return
      }

      sessionRef.current = session
      fpsEmaRef.current = 0
      lastStatsUpdateRef.current = 0
      setProviderLabel(session.providerLabel)
      setFps(0)
      setDiagnostics(null)
      send({ type: 'MODEL_READY' })
    }

    run().catch((error) => {
      if (!cancelled) {
        console.error('Model loading failed', error)
        send({ type: 'FAIL', message: String(error) })
      }
    })

    return () => {
      cancelled = true
    }
  }, [
    stage,
    state.context.model,
    backend,
    activeInputSize,
    activeModelName,
    activeTask,
    backendProbes,
    selectedBackendLabel,
    send,
  ])

  useEffect(() => {
    if (stage !== 'running') return

    const tick = async () => {
      if (
        !benchmarking &&
        !busyRef.current &&
        videoRef.current &&
        workRef.current &&
        overlayRef.current &&
        sessionRef.current &&
        videoRef.current.readyState >= 2
      ) {
        busyRef.current = true
        try {
          const frameStarted = performance.now()
          const result = await inferFrame(
            sessionRef.current,
            videoRef.current,
            workRef.current,
            activeTask,
            maskThreshold,
            objectThreshold,
          )
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

            const overlay = overlayRef.current
            overlay.width = videoRef.current.videoWidth
            overlay.height = videoRef.current.videoHeight

            const context = overlay.getContext('2d')!
            context.clearRect(0, 0, overlay.width, overlay.height)
            context.imageSmoothingEnabled = true

            if (result.task === 'segment' && result.mask && result.crop) {
              const temporary = workRef.current
              temporary.width = result.mask.width
              temporary.height = result.mask.height
              temporary.getContext('2d')!.putImageData(result.mask, 0, 0)
              context.drawImage(
                temporary,
                result.crop.x,
                result.crop.y,
                result.crop.width,
                result.crop.height,
                0,
                0,
                overlay.width,
                overlay.height,
              )
            } else {
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
                if (width > 0 && height > 0) {
                  context.strokeRect(x, y, width, height)
                  context.fillText(
                    region.score.toFixed(3),
                    x + context.lineWidth,
                    Math.max(16, y - 6),
                  )
                }
              }
            }
          }
        } catch (error) {
          console.error('Local inference failed', error)
          send({
            type: 'FAIL',
            message: error instanceof Error ? error.message : String(error),
          })
          return
        } finally {
          busyRef.current = false
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [stage, benchmarking, activeTask, maskThreshold, objectThreshold, send])

  function changeBackend(value: BackendId) {
    setBackend(value)
    if (stage === 'running' && state.context.model) {
      send({ type: 'RELOAD' })
    }
  }

  async function runBenchmark() {
    if (!state.context.model || benchmarking) return
    setBenchmarking(true)
    setBenchmarkResults([])

    try {
      let probes = backendProbes
      if (!probes.length) {
        probes = await probeBackends()
        setBackendProbes(probes)
      }
      const results = await benchmarkModel(
        state.context.model.slice(0),
        activeInputSize,
        probes,
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
  }

  async function saveOffline() {
    const client = offlineRef.current
    const model = state.context.model
    if (!client || !model) return

    setOfflineStatus('Saving app + model…')
    try {
      const savedAssets = await client.saveApp(appAssetUrls())
      await client.saveModel(model.slice(0), {
        modelName: activeModelName,
        inputSize: activeInputSize,
        savedAt: new Date().toISOString(),
      })
      setSavedModelAvailable(true)
      setOfflineStatus(`Saved offline · ${savedAssets} app files + model`)
    } catch (error) {
      setOfflineStatus(error instanceof Error ? error.message : String(error))
    }
  }

  async function loadSavedModel() {
    const client = offlineRef.current
    if (!client) return
    setOfflineStatus('Loading saved model…')

    try {
      const saved = await client.loadModel()
      if (!saved) {
        setSavedModelAvailable(false)
        setOfflineStatus('No saved model found.')
        return
      }

      setModelName(saved.metadata.modelName)
      setActiveModelName(saved.metadata.modelName)
      setProcessingSize(saved.metadata.inputSize)
      setActiveInputSize(saved.metadata.inputSize)
      setModelBytes(saved.buffer.byteLength)
      setOfflineStatus(
        `Loaded offline model saved ${new Date(saved.metadata.savedAt).toLocaleString()}`,
      )
      send({ type: 'LOAD_MODEL', model: saved.buffer })
    } catch (error) {
      setOfflineStatus(error instanceof Error ? error.message : String(error))
    }
  }

  function reset() {
    void sessionRef.current?.session.release()
    sessionRef.current = null
    fpsEmaRef.current = 0
    lastStatsUpdateRef.current = 0
    drawingRef.current = false
    drawPointsRef.current = []
    setPromptValid(false)
    setPromptMessage('Draw a closed loop and finish near the start point.')
    setProviderLabel('')
    setFps(0)
    setDiagnostics(null)
    setBenchmarkResults([])
    setBenchmarkLabel('')
    setModelBytes(0)
    if (overlayRef.current) {
      overlayRef.current
        .getContext('2d')
        ?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height)
    }
    send({ type: 'RESET' })
  }

  const settingsLocked = stage === 'exporting' || stage === 'loading' || stage === 'running'
  const modelDisplay = modelLabel(activeModelName)
  const cameraDisplay = cameraSize ? `${cameraSize.width}×${cameraSize.height}` : '—'

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>YOLOE local visual prompt</h1>
          <p className="subhead">Prompt export on server. Webcam inference stays in browser.</p>
        </div>
        <span className="stage">{stage}</span>
      </header>

      <section className="settings" aria-label="Configuration">
        <label>
          <span>Model</span>
          <select
            value={modelName}
            disabled={settingsLocked}
            onChange={(event) => setModelName(event.target.value as ModelId)}
          >
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {modelLabel(model.id)}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Camera</span>
          <select
            value={cameraMode}
            disabled={stage === 'exporting' || stage === 'loading'}
            onChange={(event) => setCameraMode(event.target.value as CameraMode)}
          >
            {CAMERA_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Processing</span>
          <select
            value={processingSize}
            disabled={settingsLocked}
            onChange={(event) => setProcessingSize(Number(event.target.value))}
          >
            {PROCESSING_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} × {size}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Inference backend</span>
          <select
            value={backend}
            disabled={stage === 'exporting' || stage === 'loading'}
            onChange={(event) => changeBackend(event.target.value as BackendId)}
          >
            {backendProbes.map((probe) => (
              <option key={probe.id} value={probe.id} disabled={!probe.available}>
                {probe.label}
              </option>
            ))}
          </select>
        </label>

        {selectedTask === 'segment' && (
          <label className="range-control">
            <span>Mask probability &gt;= {maskThreshold.toFixed(2)}</span>
            <input
              type="range"
              min="0.05"
              max="0.95"
              step="0.01"
              value={maskThreshold}
              onChange={(event) => setMaskThreshold(Number(event.target.value))}
            />
          </label>
        )}

        <label className="range-control">
          <span>Object score &gt;= {objectThreshold.toFixed(3)}</span>
          <input
            type="range"
            min="0"
            max="0.20"
            step="0.001"
            value={objectThreshold}
            onChange={(event) => setObjectThreshold(Number(event.target.value))}
          />
        </label>
      </section>

      <section className="runtime">
        <span>{stage === 'running' ? modelDisplay : modelLabel(modelName)}</span>
        <span>
          {stage === 'running'
            ? `${activeInputSize}×${activeInputSize} processing`
            : `${processingSize}×${processingSize} processing`}
        </span>
        <span>{cameraDisplay} camera</span>
        <span>{stage === 'running' ? providerLabel : selectedBackendLabel}</span>
        <strong>{stage === 'running' ? `${fps.toFixed(1)} FPS` : '-- FPS'}</strong>
      </section>

      <section className="viewport" style={{ aspectRatio: viewportAspect }}>
        <video
          ref={videoRef}
          muted
          playsInline
          className={stage === 'camera' || stage === 'running' ? '' : 'hidden'}
        />
        <canvas
          ref={captureCanvas}
          className={
            stage === 'prompt' || stage === 'exporting' || stage === 'loading' ? '' : 'hidden'
          }
        />
        <canvas
          ref={overlayRef}
          className="overlay"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        />
        <canvas ref={workRef} className="hidden" />

        {(stage === 'exporting' || stage === 'loading') && (
          <div className="busy">
            <div className="spinner" />
            <strong>
              {stage === 'exporting'
                ? `Baking prompt + exporting ${selectedTask === 'segment' ? 'segmentation' : 'localization'} model`
                : 'Model exported. Loading local runtime'}
            </strong>
            <span>
              {stage === 'exporting'
                ? `${modelLabel(modelName)} · ${processingSize}×${processingSize}. The server is only creating the prompted ONNX.`
                : loadingMessage}
            </span>
          </div>
        )}
      </section>

      <nav>
        {stage === 'camera' && <button onClick={capture}>Capture</button>}
        {stage === 'camera' && savedModelAvailable && (
          <button className="secondary" onClick={loadSavedModel}>
            Use saved model
          </button>
        )}
        {stage === 'prompt' && (
          <button disabled={!promptValid} onClick={exportModel}>
            Use closed region
          </button>
        )}
        {stage === 'running' && (
          <button className="secondary" disabled={benchmarking} onClick={runBenchmark}>
            {benchmarking ? 'Benchmarking…' : 'Benchmark'}
          </button>
        )}
        {stage === 'running' && offlineReady && (
          <button className="secondary" onClick={saveOffline}>
            Save offline
          </button>
        )}
        {stage !== 'camera' && (
          <button className="secondary" onClick={reset}>
            Reset
          </button>
        )}
        <a className="button secondary" href="/downloads/yoloe-browser-seg-source.zip" download>
          Download source
        </a>
      </nav>

      <p className={stage === 'prompt' && !promptValid ? 'hint warning' : 'hint'}>
        {stage === 'camera' && 'Frame the object, then capture.'}
        {stage === 'prompt' && promptMessage}
        {stage === 'running' &&
          activeTask === 'detect' &&
          `Boxes are produced directly by the prompted YOLOE-26 detection head. Object threshold ${objectThreshold.toFixed(3)}. ` +
            `Model ${(modelBytes / 1_048_576).toFixed(1)} MiB.`}
        {stage === 'running' &&
          activeTask === 'segment' &&
          `Green overlay opacity is mask probability. Mask threshold ${maskThreshold.toFixed(2)}; object threshold ${objectThreshold.toFixed(3)}. ` +
            `Model ${(modelBytes / 1_048_576).toFixed(1)} MiB.`}

        {stage === 'error' && state.context.error}
      </p>

      {stage === 'running' && diagnostics && (
        <div className="diagnostics">
          <span>{diagnostics.detections} candidates</span>
          <span>object max {diagnostics.maxScore.toFixed(3)}</span>
          {activeTask === 'segment' && diagnostics.maxMaskProbability !== undefined && (
            <span>mask max {diagnostics.maxMaskProbability.toFixed(3)}</span>
          )}
          <span>{diagnostics.inferenceMs.toFixed(1)} ms model</span>
        </div>
      )}

      {(benchmarking || benchmarkResults.length > 0 || benchmarkLabel) && (
        <section className="benchmark">
          <div>
            <strong>Random-input benchmark</strong>
            <span>
              {modelDisplay} · {activeInputSize}×{activeInputSize} · model inference only
            </span>
          </div>
          {benchmarkLabel && <p>{benchmarkLabel}</p>}
          {benchmarkResults.map((result) => (
            <p key={result.backend}>
              <span>{result.label}</span>
              <strong>
                {result.ok
                  ? `${result.fps.toFixed(1)} FPS · ${result.ms.toFixed(1)} ms`
                  : result.error}
              </strong>
            </p>
          ))}
        </section>
      )}

      {offlineStatus && <p className="offline-status">{offlineStatus}</p>}
    </main>
  )
}
