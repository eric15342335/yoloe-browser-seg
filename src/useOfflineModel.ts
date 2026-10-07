import { useCallback, useEffect, useRef, useState } from 'react'

import { APP_VERSION, isModelId, isProcessingSize, type ModelId } from './config'
import { appAssetUrls, connectOfflineWorker, type OfflineClient, type SavedModel } from './offline'

type ValidatedSavedModel = Omit<SavedModel, 'metadata'> & {
  metadata: Omit<SavedModel['metadata'], 'modelName'> & { modelName: ModelId }
}

export function useOfflineModel() {
  const clientRef = useRef<OfflineClient | null>(null)
  const [offlineReady, setOfflineReady] = useState(false)
  const [savedModelAvailable, setSavedModelAvailable] = useState(false)
  const [offlineStatus, setOfflineStatus] = useState('')

  useEffect(() => {
    let active = true

    const connect = async () => {
      try {
        const client = await connectOfflineWorker()
        if (!client) return
        const hasModel = await client.hasModel()
        if (!active) return

        clientRef.current = client
        setOfflineReady(true)
        setSavedModelAvailable(hasModel)
      } catch (error) {
        console.warn('Offline worker unavailable', error)
      }
    }

    void connect()
    return () => {
      active = false
      clientRef.current = null
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

  const saveModel = useCallback(
    async (buffer: ArrayBuffer, modelName: ModelId, inputSize: number) => {
      const client = clientRef.current
      if (!client) return

      setOfflineStatus('Saving app + model…')
      try {
        const savedAssets = await client.saveApp(appAssetUrls())
        await client.saveModel(buffer.slice(0), {
          modelName,
          inputSize,
          savedAt: new Date().toISOString(),
        })
        setSavedModelAvailable(true)
        setOfflineStatus(`Saved offline · ${savedAssets} app files + model`)
      } catch (error) {
        setOfflineStatus(error instanceof Error ? error.message : String(error))
      }
    },
    [],
  )

  const loadModel = useCallback(async (): Promise<ValidatedSavedModel | null> => {
    const client = clientRef.current
    if (!client) return null

    setOfflineStatus('Loading saved model…')
    try {
      const saved = await client.loadModel()
      if (!saved) {
        setSavedModelAvailable(false)
        setOfflineStatus('No saved model found.')
        return null
      }

      if (!isModelId(saved.metadata.modelName) || !isProcessingSize(saved.metadata.inputSize)) {
        setOfflineStatus('Saved model metadata is not compatible with this app version.')
        return null
      }

      setOfflineStatus(
        `Loaded offline model saved ${new Date(saved.metadata.savedAt).toLocaleString()}`,
      )
      return {
        ...saved,
        metadata: { ...saved.metadata, modelName: saved.metadata.modelName },
      }
    } catch (error) {
      setOfflineStatus(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [])

  return {
    offlineReady,
    savedModelAvailable,
    offlineStatus,
    saveModel,
    loadModel,
  }
}
