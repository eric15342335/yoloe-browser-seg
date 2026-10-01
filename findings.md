# Findings

- Ultralytics documents yoloe-26n-seg visual prompting and states prompt embeddings are baked into exported ONNX models.
- Internally the visual-prompt predictor has mask handling, but Ultralytics 8.4.164 public `YOLOE.predict()` asserts `bboxes` + `cls`; the free-form lasso is therefore converted to its tight box.
- Real yoloe-26n-seg ONNX export at imgsz=320 is about 10.5 MB with input `[1,3,320,320]` and outputs `[1,300,38]`, `[1,32,80,80]`.
- ONNX Runtime Web supports executionProviders ['webgpu', 'wasm']; WASM is the CPU fallback.
- Exact user LFM2.5-VL browser repository was not identifiable through available GitHub scope/public search, so requested architecture/QoL choices are reproduced directly.

## 2026-09-28 configurable pass

- WebGPU adapter identifying fields are privacy-limited; use adapter.info description/device/vendor/architecture when exposed, otherwise report generic available.
- ORT Web supports explicit executionProviders such as webgpu and wasm; benchmark can stay entirely client-side after ONNX export.
- Comlink's documented service-worker pattern uses MessageChannel: page transfers one port to navigator.serviceWorker.controller, then Comlink.wrap(port2); service worker Comlink.expose(api, transferredPort).
- YOLOE-26 visual-prompt segmentation checkpoints available: 26n/s/m/l/x.

## v6 verification

- Playwright fake-camera E2E: crossOriginIsolated=true; camera negotiated 3840x2160.
- Closed lasso UI accepted near-closed loop and showed snap distance + filled prompt mask.
- Browser backend probe correctly showed CPU/WASM (4 threads) and WebGPU unavailable in headless sandbox.
- Live FPS reports via EMA; CPU/WASM headless measured about 0.7-1.1 FPS at 256 input in this sandbox.
- Random-input benchmark ran locally and offline; measured about 1.9 FPS / 527.6 ms in headless sandbox.
- Save Offline cached 14 app resources plus ONNX; offline reload, saved-model load, and benchmark completed with zero failed requests and zero console errors.
- Configurable export at 256 produced ONNX input [1,3,256,256] and outputs [1,300,38], [1,32,64,64].

## v7 verification

- ONNX Runtime Web threading switched to native auto mode: env.wasm.numThreads=0 when crossOriginIsolated, otherwise 1.
- Official ORT browser default is min(4, ceil(navigator.hardwareConcurrency / 2)); UI shows chosen default and reported logical-thread count.
- Output task is live-switchable: segmentation probability, object localization, oriented bounding box.
- OBB is a client-side minimum-area rectangle fitted to thresholded YOLOE prompted-mask pixels; no second model or server inference.
- Playwright v7 E2E: minimum computed UI font 11px; stage and viewport radii both 10px; no visible arrow or >= Unicode glyphs.
- E2E forced permissive thresholds and verified non-empty overlay pixels for all three output tasks with zero browser errors.
- Public source ZIP downloads successfully and excludes node_modules, .venv, model weights, telemetry data, dist, and .git.

## v8 correction

- Removed OBB from the product and deleted the custom convex-hull/minimum-area-rectangle implementation.
- Kept object localization because YOLOE segmentation natively returns detection boxes alongside instance masks; the browser only renders those model-produced boxes.

## v10 modernization

- Upgraded Vite 7.3.6 -> 8.3.1 and @vitejs/plugin-react 5.2.0 -> 6.1.1.
- Upgraded TypeScript 5.9.3 -> 7.0.2. Added src/vite-env.d.ts because TS 7 checks CSS side-effect imports more strictly.
- Updated manifest baselines to React 19.3.0, React DOM 19.3.0, XState 5.33.2, @xstate/react 6.1.0, ONNX Runtime Web 1.30.0, Sentry Browser 11.1.0, and matching React types.
- Added packageManager=bun@1.4.2; bun outdated is empty after the migration.
- Vite 8 production build on this sandbox dropped from roughly 7.7-8.2s to about 2.5-3.0s and JS from ~502 kB to ~494 kB before gzip.
- Oxlint, strict TS, Knip, Ruff, axe, Lighthouse, and public-tunnel fake-camera smoke all pass.
- Vite preview proxies /api to FastAPI, so frontend/backend APP_VERSION must match during browser tests; a mismatch intentionally causes reload.

## v11 localization-only pass

- Default browser backend is CPU/WASM; Auto also prefers CPU/WASM and falls back to WebGPU only if CPU session creation fails.
- Default object score threshold is 0.010.
- Removed task selector and mask-threshold UI entirely.
- Backend now extracts the visual prompt embedding from the official YOLOE-26 _-seg.pt visual-prompt checkpoint, transfers it into the matching detection-only yoloe-26_.yaml architecture, then exports detect-only ONNX.
- Verified API export yoloe-26n at 256: input [1,3,256,256], single output [1,300,6], X-Model-Task=detect, ~9.7 MB response.
- Browser E2E observed a distinct post-export loading state before realtime inference: spinner + "Model exported. Loading local runtime" + initialization description.
- Final public browser E2E: backend=wasm by default, Auto option explicitly says CPU/WASM, object threshold=0.01, no task selector, zero console/page errors.

## v12 model-choice task split

- Removed the Auto backend option entirely. Inference backend now has only CPU/WASM and WebGPU; CPU/WASM remains the default.
- Model dropdown now contains five YOLOE-26 localization choices and five official YOLOE-26 segmentation checkpoint choices. Default remains yoloe-26n localization.
- Selecting a segmentation model conditionally restores the mask-probability threshold; no separate task dropdown exists.
- Backend supports both exports from the same visual prompt: detect-only architecture transfer for localization and prompted segmentation export for segmentation.
- Verified 256 detect export: [1,300,6]. Verified 256 segment export: [1,300,38] plus [1,32,64,64].
- Browser E2E verified two backend options, ten model options, localization default, segmentation selection/runtime, and zero browser/page errors.

## App.tsx render-frequency cleanup

- Replaced drawing React state with drawingRef because drawing only guards pointer handlers and does not affect JSX.
- Added lastStatsUpdateRef and throttled rendered FPS/diagnostics state updates to at most once every 250 ms.
- Inference, EMA calculation, and canvas rendering remain unthrottled.
- promptValid remains React state; no XState/config ownership refactor was included.
- Browser smoke verified closed-region drawing, realtime inference, and zero page/console errors.
