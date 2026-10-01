import * as Comlink from 'comlink'

import type { ModelId } from './config'

type SavedModelMeta = {
  modelName: ModelId
  inputSize: number
  savedAt: string
}

type SavedModel = {
  buffer: ArrayBuffer
  metadata: SavedModelMeta
}

type OfflineApi = {
  saveApp(urls: string[]): Promise<number>
  saveModel(buffer: ArrayBuffer, metadata: SavedModelMeta): Promise<void>
  loadModel(): Promise<SavedModel | null>
  hasModel(): Promise<boolean>
  clearModel(): Promise<void>
}

export type OfflineClient = Comlink.Remote<OfflineApi>

export async function connectOfflineWorker(): Promise<OfflineClient | null> {
  if (!('serviceWorker' in navigator)) return null

  const registration = await navigator.serviceWorker.register('/sw.js', {
    type: 'module',
    scope: '/',
  })
  await navigator.serviceWorker.ready

  const worker = navigator.serviceWorker.controller ?? registration.active
  if (!worker) return null

  const { port1, port2 } = new MessageChannel()
  worker.postMessage({ comlinkInit: true }, [port1])
  port2.start()
  return Comlink.wrap<OfflineApi>(port2)
}

export function appAssetUrls(): string[] {
  const urls = new Set<string>([
    new URL('/', location.origin).href,
    new URL('/manifest.webmanifest', location.origin).href,
    new URL('/comlink.mjs', location.origin).href,
    new URL('/sw.js', location.origin).href,
    new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', location.origin).href,
    new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', location.origin).href,
  ])

  document.querySelectorAll<HTMLScriptElement>('script[src]').forEach((node) => {
    const url = new URL(node.src, location.href)
    if (url.origin === location.origin) urls.add(url.href)
  })
  document.querySelectorAll<HTMLLinkElement>('link[href]').forEach((node) => {
    const url = new URL(node.href, location.href)
    if (url.origin === location.origin) urls.add(url.href)
  })
  performance.getEntriesByType('resource').forEach((entry) => {
    const url = new URL(entry.name, location.href)
    if (url.origin === location.origin && !url.pathname.startsWith('/api/')) {
      urls.add(url.href)
    }
  })

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        for (const match of rule.cssText.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
          const url = new URL(match[1], sheet.href ?? location.href)
          if (url.origin === location.origin) urls.add(url.href)
        }
      }
    } catch {
      // Cross-origin stylesheets are intentionally ignored.
    }
  }

  return [...urls]
}
