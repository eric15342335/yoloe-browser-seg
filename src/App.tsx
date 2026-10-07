import { useMachine } from '@xstate/react'
import { useState } from 'react'

import {
  CAMERA_MODES,
  DEFAULT_MODEL,
  DEFAULT_PROCESSING_SIZE,
  MODELS,
  PROCESSING_SIZES,
  isModelId,
  modelLabel,
  modelTask,
  type BackendId,
  type CameraMode,
  type ModelId,
} from './config'
import { appMachine } from './machine'
import { useCapturePrompt } from './useCapturePrompt'
import { useInferenceRuntime } from './useInferenceRuntime'
import { useOfflineModel } from './useOfflineModel'

const API = '/api/export'

export default function App() {
  const [state, send] = useMachine(appMachine)

  const [modelName, setModelName] = useState<ModelId>(DEFAULT_MODEL)
  const [processingSize, setProcessingSize] = useState(DEFAULT_PROCESSING_SIZE)
  const [cameraMode, setCameraMode] = useState<CameraMode>('max')
  const [backend, setBackend] = useState<BackendId>('wasm')
  const [maskThreshold, setMaskThreshold] = useState(0.5)
  const [objectThreshold, setObjectThreshold] = useState(0.01)

  const stage = state.value
  const isCamera = state.matches('camera')
  const isPrompt = state.matches('prompt')
  const isExporting = state.matches('exporting')
  const isLoading = state.matches('loading')
  const isRunning = state.matches('running')
  const isError = state.matches('error')
  const settingsLocked = state.hasTag('settingsLocked')
  const promptValid = !!state.context.capture && state.context.polygon.length >= 3
  const activeModelName = state.context.model?.modelName ?? modelName
  const activeTask = modelTask(activeModelName)

  const {
    videoRef,
    captureCanvas,
    overlayRef,
    cameraSize,
    promptMessage,
    capture,
    pointerDown,
    pointerMove,
    pointerUp,
  } = useCapturePrompt({
    cameraMode,
    isCamera,
    isRunning,
    isPrompt,
    send,
  })

  const {
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
  } = useInferenceRuntime({
    isLoading,
    isRunning,
    model: state.context.model,
    activeTask,
    backend,
    maskThreshold,
    objectThreshold,
    videoRef,
    overlayRef,
    send,
  })

  const { offlineReady, savedModelAvailable, offlineStatus, saveModel, loadModel } =
    useOfflineModel()

  const selectedTask = modelTask(modelName)
  const activeInputSize = state.context.model?.inputSize ?? processingSize
  const modelBytes = state.context.model?.buffer.byteLength ?? 0
  const modelDisplay = modelLabel(activeModelName)
  const cameraDisplay = cameraSize ? `${cameraSize.width}×${cameraSize.height}` : '—'
  const viewportAspect = cameraSize ? `${cameraSize.width} / ${cameraSize.height}` : '16 / 9'

  async function exportModel() {
    const captureBlob = state.context.capture
    const polygon = state.context.polygon
    const canvas = captureCanvas.current
    if (!captureBlob || polygon.length < 3 || !canvas) return

    send({ type: 'EXPORT' })

    try {
      const form = new FormData()
      form.append('image', captureBlob, 'capture.jpg')
      form.append('polygon', JSON.stringify(polygon))
      form.append('width', String(canvas.width))
      form.append('height', String(canvas.height))
      form.append('model_name', modelName)
      form.append('imgsz', String(processingSize))

      const response = await fetch(API, { method: 'POST', body: form })
      if (!response.ok) throw new Error(await response.text())

      send({
        type: 'EXPORTED',
        model: {
          buffer: await response.arrayBuffer(),
          modelName,
          inputSize: processingSize,
        },
      })
    } catch (error) {
      send({
        type: 'FAIL',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function changeBackend(value: BackendId) {
    setBackend(value)
    if (isRunning && state.context.model) send({ type: 'RELOAD' })
  }

  async function saveOffline() {
    const model = state.context.model
    if (!model) return
    await saveModel(model.buffer, model.modelName, model.inputSize)
  }

  async function loadSavedModel() {
    const saved = await loadModel()
    if (!saved) return

    const savedModelName = saved.metadata.modelName
    setModelName(savedModelName)
    setProcessingSize(saved.metadata.inputSize)
    send({
      type: 'LOAD_MODEL',
      model: {
        buffer: saved.buffer,
        modelName: savedModelName,
        inputSize: saved.metadata.inputSize,
      },
    })
  }

  function reset() {
    resetRuntime()
    send({ type: 'RESET' })
  }

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
            onChange={(event) => {
              if (isModelId(event.target.value)) setModelName(event.target.value)
            }}
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
            disabled={isExporting || isLoading}
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
            disabled={isExporting || isLoading}
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
        <span>{isRunning ? modelDisplay : modelLabel(modelName)}</span>
        <span>
          {isRunning
            ? `${activeInputSize}×${activeInputSize} processing`
            : `${processingSize}×${processingSize} processing`}
        </span>
        <span>{cameraDisplay} camera</span>
        <span>{isRunning ? providerLabel : selectedBackendLabel}</span>
        <strong>{isRunning ? `${fps.toFixed(1)} FPS` : '-- FPS'}</strong>
      </section>

      <section className="viewport" style={{ aspectRatio: viewportAspect }}>
        <video ref={videoRef} muted playsInline className={isCamera || isRunning ? '' : 'hidden'} />
        <canvas
          ref={captureCanvas}
          className={isPrompt || isExporting || isLoading ? '' : 'hidden'}
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

        {(isExporting || isLoading) && (
          <div className="busy">
            <div className="spinner" />
            <strong>
              {isExporting
                ? `Baking prompt + exporting ${selectedTask === 'segment' ? 'segmentation' : 'localization'} model`
                : 'Model exported. Loading local runtime'}
            </strong>
            <span>
              {isExporting
                ? `${modelLabel(modelName)} · ${processingSize}×${processingSize}. The server is only creating the prompted ONNX.`
                : loadingMessage}
            </span>
          </div>
        )}
      </section>

      <nav>
        {isCamera && <button onClick={capture}>Capture</button>}
        {isCamera && savedModelAvailable && (
          <button className="secondary" onClick={loadSavedModel}>
            Use saved model
          </button>
        )}
        {isPrompt && (
          <button disabled={!promptValid} onClick={exportModel}>
            Use closed region
          </button>
        )}
        {isRunning && (
          <button className="secondary" disabled={benchmarking} onClick={runBenchmark}>
            {benchmarking ? 'Benchmarking…' : 'Benchmark'}
          </button>
        )}
        {isRunning && offlineReady && (
          <button className="secondary" onClick={saveOffline}>
            Save offline
          </button>
        )}
        {!isCamera && (
          <button className="secondary" onClick={reset}>
            Reset
          </button>
        )}
        <a className="button secondary" href="/downloads/yoloe-browser-seg-source.zip" download>
          Download source
        </a>
      </nav>

      <p className={isPrompt && !promptValid ? 'hint warning' : 'hint'}>
        {isCamera && 'Frame the object, then capture.'}
        {isPrompt && promptMessage}
        {isRunning &&
          activeTask === 'detect' &&
          `Boxes are produced directly by the prompted YOLOE-26 detection head. Object threshold ${objectThreshold.toFixed(3)}. ` +
            `Model ${(modelBytes / 1_048_576).toFixed(1)} MiB.`}
        {isRunning &&
          activeTask === 'segment' &&
          `Green overlay opacity is mask probability. Mask threshold ${maskThreshold.toFixed(2)}; object threshold ${objectThreshold.toFixed(3)}. ` +
            `Model ${(modelBytes / 1_048_576).toFixed(1)} MiB.`}

        {isError && state.context.error}
      </p>

      {isRunning && diagnostics && (
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
