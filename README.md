# YOLOE local visual prompt

Minimal visual-prompt object localization and segmentation with server-side model export and browser-local inference.

1. Browser captures a webcam frame.
2. User draws a closed free-form region around one example object. The UI shows the snapped, filled polygon that will be used as the prompt.
3. FastAPI rasterizes that polygon into the YOLOE visual prompt, extracts its prompt embedding from the selected YOLOE-26 visual-prompt checkpoint, transfers that embedding into the matching detection-only YOLOE-26 architecture, and exports fixed-shape ONNX.
4. Browser loads the returned ONNX with ONNX Runtime Web.
5. Webcam inference stays local. CPU/WASM is the default backend; WebGPU remains selectable when available. The selected model determines whether the browser renders model-native detection boxes or segmentation masks.
6. Reset discards the active model and returns to capture.

## Development

Frontend:

```bash
bun install
bun run dev
```

Backend:

```bash
cd backend
uv sync
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

Production:

```bash
bun run build
cd backend
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

Vite production builds emit external JavaScript source maps.

Current frontend baseline: Bun 1.4.2, React 19.3, TypeScript 7, Vite 8 with Rolldown, and @vitejs/plugin-react 6. Bun is the package manager/runtime used by the project; Vite 8 also documents Node 20.19+ or 22.12+ when run under Node.

## Quality gates

Frontend and TypeScript:

```bash
bun run format:check   # Oxfmt
bun run lint           # Oxlint, including type-aware, React hooks and JSX a11y rules
bun run typecheck      # TypeScript strict mode
bun run deadcode       # Knip
bun run build
bun run a11y           # Playwright + axe WCAG A/AA scan
bun run lhci
```

Python:

```bash
bun run py:lint
bun run py:format:check
```

Ruff is configured with `I` import-sorting rules plus E/F/UP/B/SIM checks. Both TypeScript projects use `strict: true`.

## Workspace Agent Skills

Project-scoped Agent Skills are committed under `.agents/skills/`:

- `i-have-adhd`
- `humanizer`
- `ponytail`
- `planning-with-files`
- `caveman`

They were installed with the Agent Skills CLI in project scope for Codex. `planning-with-files` additionally uses its documented Codex workspace integration in `.codex/hooks.json` and `.codex/hooks/`. The Skills CLI records the installations in `skills-lock.json`.

Codex reviews newly added or changed workspace hooks through its normal trust flow.

## Architecture boundary

The backend is used only to create prompted ONNX models. After the ONNX response is received, webcam frames, inference, task rendering, threshold changes, benchmarking, and saved-model offline use stay in the browser.
