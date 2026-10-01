import * as Sentry from '@sentry/browser'

export function initTelemetry() {
  const dsn = `${location.protocol}//browser@${location.host}/telemetry/1`
  Sentry.init({
    dsn,
    environment: 'quick-tunnel',
    release: 'yoloe-browser-seg@12',
    enabled: navigator.onLine,
    tracesSampleRate: 0,
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error', 'warn'] })],
    beforeSend(event) {
      const message = event.message ?? event.exception?.values?.[0]?.value ?? ''
      if (message.includes('VerifyEachNodeIsAssignedToAnEp')) return null
      if (event.request?.url) {
        try {
          const url = new URL(event.request.url)
          url.search = ''
          url.hash = ''
          event.request.url = url.toString()
        } catch {
          /* ignore malformed URL */
        }
      }
      return event
    },
  })
}
