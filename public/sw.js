import * as Comlink from '/comlink.mjs'

const APP_CACHE_PREFIX = 'yoloe-app-v'
let appCachePromise

function appCache() {
  if (!appCachePromise) {
    appCachePromise = (async () => {
      try {
        const response = await fetch('/api/version', { cache: 'no-store' })
        if (response.ok) {
          const data = await response.json()
          if (data.version) {
            return { name: `${APP_CACHE_PREFIX}${data.version}`, authoritative: true }
          }
        }
      } catch {}

      const existing = (await caches.keys()).find((key) => key.startsWith(APP_CACHE_PREFIX))
      return { name: existing ?? `${APP_CACHE_PREFIX}offline`, authoritative: false }
    })()
  }
  return appCachePromise
}
const MODEL_CACHE = 'yoloe-model-v3'
const MODEL_URL = '/__offline/model.onnx'
const META_URL = '/__offline/model.json'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open((await appCache()).name)
      try {
        const response = await fetch('/', { cache: 'reload' })
        if (response.ok) await cache.put('/', response)
      } catch {}
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const current = await appCache()
      if (current.authoritative) {
        const keys = await caches.keys()
        await Promise.all(
          keys
            .filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== current.name)
            .map((key) => caches.delete(key)),
        )
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/telemetry/')) return
  if (url.pathname.startsWith('/__offline/')) return

  event.respondWith(
    (async () => {
      const cache = await caches.open((await appCache()).name)
      const cached = await cache.match(request)
      try {
        const response = await fetch(request)
        if (response.ok) await cache.put(request, response.clone())
        return response
      } catch (error) {
        if (cached) return cached
        throw error
      }
    })(),
  )
})

const api = {
  async saveApp(urls) {
    const cache = await caches.open((await appCache()).name)
    let saved = 0
    for (const value of urls) {
      const url = new URL(value, self.location.origin)
      if (url.origin !== self.location.origin) continue
      try {
        const response = await fetch(url.href, { cache: 'reload' })
        if (!response.ok) continue
        await cache.put(url.href, response)
        saved += 1
      } catch {}
    }
    return saved
  },

  async saveModel(buffer, metadata) {
    const cache = await caches.open(MODEL_CACHE)
    await cache.put(
      MODEL_URL,
      new Response(buffer, { headers: { 'Content-Type': 'application/octet-stream' } }),
    )
    await cache.put(
      META_URL,
      new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' } }),
    )
  },

  async loadModel() {
    const cache = await caches.open(MODEL_CACHE)
    const [modelResponse, metaResponse] = await Promise.all([
      cache.match(MODEL_URL),
      cache.match(META_URL),
    ])
    if (!modelResponse || !metaResponse) return null
    return {
      buffer: await modelResponse.arrayBuffer(),
      metadata: await metaResponse.json(),
    }
  },

  async hasModel() {
    const cache = await caches.open(MODEL_CACHE)
    return !!(await cache.match(MODEL_URL))
  },

  async clearModel() {
    await caches.delete(MODEL_CACHE)
  },
}

self.addEventListener('message', (event) => {
  if (event.data?.comlinkInit && event.ports[0]) {
    Comlink.expose(api, event.ports[0])
  }
})
