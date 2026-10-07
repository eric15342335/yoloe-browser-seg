import { assign, setup } from 'xstate'

import type { ModelId } from './config'

export type Point = { x: number; y: number }

export type LoadedModel = {
  buffer: ArrayBuffer
  modelName: ModelId
  inputSize: number
}

type Ctx = {
  capture: Blob | null
  polygon: Point[]
  model: LoadedModel | null
  error: string | null
}

export type AppEvent =
  | { type: 'CAPTURED'; blob: Blob }
  | { type: 'POLYGON'; points: Point[] }
  | { type: 'EXPORT' }
  | { type: 'EXPORTED'; model: LoadedModel }
  | { type: 'LOAD_MODEL'; model: LoadedModel }
  | { type: 'MODEL_READY' }
  | { type: 'RELOAD' }
  | { type: 'FAIL'; message: string }
  | { type: 'RESET' }

export const appMachine = setup({
  types: {
    context: {} as Ctx,
    events: {} as AppEvent,
    tags: {} as 'settingsLocked',
  },
  guards: {
    hasPrompt: ({ context }) => !!context.capture && context.polygon.length >= 3,
  },
}).createMachine({
  id: 'app',
  initial: 'camera',
  context: { capture: null, polygon: [], model: null, error: null },
  on: {
    RESET: {
      target: '.camera',
      actions: assign({ capture: null, polygon: [], model: null, error: null }),
    },
    FAIL: {
      target: '.error',
      actions: assign({ error: ({ event }) => event.message }),
    },
  },
  states: {
    camera: {
      on: {
        CAPTURED: {
          target: 'prompt',
          actions: assign({ capture: ({ event }) => event.blob, polygon: [] }),
        },
        LOAD_MODEL: {
          target: 'loading',
          actions: assign({ model: ({ event }) => event.model }),
        },
      },
    },
    prompt: {
      on: {
        POLYGON: { actions: assign({ polygon: ({ event }) => event.points }) },
        EXPORT: { target: 'exporting', guard: 'hasPrompt' },
      },
    },
    exporting: {
      tags: 'settingsLocked',
      on: {
        EXPORTED: {
          target: 'loading',
          actions: assign({ model: ({ event }) => event.model }),
        },
      },
    },
    loading: {
      tags: 'settingsLocked',
      on: { MODEL_READY: 'running' },
    },
    running: {
      tags: 'settingsLocked',
      on: { RELOAD: 'loading' },
    },
    error: {},
  },
})
