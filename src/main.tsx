import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'

import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import './styles.css'
import { initTelemetry } from './telemetry'

initTelemetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
