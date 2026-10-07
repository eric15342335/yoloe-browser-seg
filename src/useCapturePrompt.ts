import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'

import { cameraConstraints, type CameraMode } from './config'
import type { AppEvent, Point } from './machine'

const DEFAULT_PROMPT_MESSAGE = 'Draw a closed loop and finish near the start point.'

type FrameSize = { width: number; height: number }
type Send = (event: AppEvent) => void

type Options = {
  cameraMode: CameraMode
  isCamera: boolean
  isRunning: boolean
  isPrompt: boolean
  send: Send
}

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

function canvasPoint(event: PointerEvent<HTMLCanvasElement>): Point {
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

export function useCapturePrompt({ cameraMode, isCamera, isRunning, isPrompt, send }: Options) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const captureCanvas = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const drawPointsRef = useRef<Point[]>([])
  const drawingRef = useRef(false)

  const [cameraSize, setCameraSize] = useState<FrameSize | null>(null)
  const [promptMessage, setPromptMessage] = useState(DEFAULT_PROMPT_MESSAGE)

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
    const video = videoRef.current
    if (!video) return

    video.srcObject = stream
    await video.play()
    const settings = track?.getSettings()
    setCameraSize({
      width: settings?.width ?? video.videoWidth,
      height: settings?.height ?? video.videoHeight,
    })
  }, [cameraMode, stopCamera])

  useEffect(() => {
    if (!isCamera && !isRunning) {
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
  }, [isCamera, isRunning, send, startCamera, stopCamera])

  useEffect(() => {
    if (!isCamera) return
    drawingRef.current = false
    drawPointsRef.current = []

    const overlay = overlayRef.current
    const context = overlay?.getContext('2d')
    if (overlay && context) context.clearRect(0, 0, overlay.width, overlay.height)
  }, [isCamera])

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

    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(video, 0, 0)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    })
    if (!blob) return

    setCameraSize({ width: video.videoWidth, height: video.videoHeight })
    stopCamera()
    drawPointsRef.current = []
    setPromptMessage(DEFAULT_PROMPT_MESSAGE)
    send({ type: 'CAPTURED', blob })
  }

  function redrawSelection(points: Point[], mode: 'drawing' | 'valid' | 'invalid', rawEnd?: Point) {
    const canvas = overlayRef.current
    const base = captureCanvas.current
    if (!canvas || !base) return

    canvas.width = base.width
    canvas.height = base.height
    const context = canvas.getContext('2d')
    if (!context) return

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

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!isPrompt) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = canvasPoint(event)
    drawPointsRef.current = [point]
    drawingRef.current = true
    setPromptMessage('Keep drawing. Finish near the green start point.')
    send({ type: 'POLYGON', points: [] })
    redrawSelection([point], 'drawing')
  }

  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !isPrompt) return
    const point = canvasPoint(event)
    const points = drawPointsRef.current
    const previous = points[points.length - 1]
    const minimumStep = Math.max(2, event.currentTarget.width / 640)
    if (previous && pointDistance(previous, point) < minimumStep) return
    points.push(point)
    redrawSelection(points, 'drawing')
  }

  function pointerUp() {
    if (!drawingRef.current || !isPrompt) return
    drawingRef.current = false

    const canvas = overlayRef.current
    if (!canvas) return

    const raw = compactPoints(drawPointsRef.current)
    if (raw.length < 6) {
      setPromptMessage('Region rejected: draw a loop, not a short line.')
      send({ type: 'POLYGON', points: [] })
      redrawSelection(raw, 'invalid')
      return
    }

    const first = raw[0]
    const rawEnd = raw[raw.length - 1]
    const closeDistance = pointDistance(first, rawEnd)
    const closeLimit = Math.max(24, Math.min(canvas.width, canvas.height) * 0.08)
    const area = polygonArea(raw)
    const minimumArea = canvas.width * canvas.height * 0.002

    if (closeDistance > closeLimit) {
      setPromptMessage(
        `Region rejected: endpoint is ${Math.round(closeDistance)} px from start. Close the loop.`,
      )
      send({ type: 'POLYGON', points: [] })
      redrawSelection(raw, 'invalid')
      return
    }

    if (area < minimumArea) {
      setPromptMessage('Region rejected: enclosed area is too small.')
      send({ type: 'POLYGON', points: [] })
      redrawSelection(raw, 'invalid')
      return
    }

    const processed = [...raw.slice(0, -1), first]
    drawPointsRef.current = processed
    setPromptMessage(
      `Closed region ready. Endpoint snapped by ${Math.round(closeDistance)} px; filled preview is the exact prompt mask.`,
    )
    send({ type: 'POLYGON', points: processed })
    redrawSelection(processed, 'valid', rawEnd)
  }

  return {
    videoRef,
    captureCanvas,
    overlayRef,
    cameraSize,
    promptMessage,
    capture,
    pointerDown,
    pointerMove,
    pointerUp,
  }
}
