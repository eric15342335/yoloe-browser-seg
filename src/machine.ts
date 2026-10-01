import { assign, setup } from 'xstate'

export type Point = { x: number; y: number }

type Ctx = {
  capture: Blob | null
  polygon: Point[]
  model: ArrayBuffer | null
  error: string | null
}

export const appMachine = setup({
  types: {
    context: {} as Ctx,
    events: {} as
      | { type: 'CAPTURED'; blob: Blob }
      | { type: 'POLYGON'; points: Point[] }
      | { type: 'EXPORT' }
      | { type: 'EXPORTED'; model: ArrayBuffer }
      | { type: 'LOAD_MODEL'; model: ArrayBuffer }
      | { type: 'MODEL_READY' }
      | { type: 'RELOAD' }
      | { type: 'FAIL'; message: string }
      | { type: 'RESET' },
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
      on: {
        EXPORTED: {
          target: 'loading',
          actions: assign({ model: ({ event }) => event.model }),
        },
      },
    },
    loading: { on: { MODEL_READY: 'running' } },
    running: { on: { RELOAD: 'loading' } },
    error: {},
  },
})
