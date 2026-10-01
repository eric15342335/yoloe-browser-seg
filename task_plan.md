# Task plan

1. [done] Validate current YOLOE visual-prompt export semantics and browser runtime.
2. [done] Implement minimal React/XState webcam capture + free-form lasso.
3. [done] Implement FastAPI export-only backend using yoloe-26n-seg and supported visual prompt boxes derived from the lasso.
4. [done] Implement ONNX Runtime Web inference with WebGPU then WASM fallback.
5. [done] Build, test real HTTP export, inspect/execute ONNX outputs, publish Cloudflare Quick Tunnel.

Constraints: Bun for JS, uv for Python, backend used only for export. External research belongs in findings.md.

## Configurable local inference pass

- [x] Runtime status: loading, FPS, full model name, provider/device.
- [x] Config: YOLOE-26 model size, camera resolution, processing resolution, mask threshold, execution backend.
- [x] Prompt UX: require near-closed lasso; show snapped/closed postprocessed region.
- [x] Probability overlay: alpha encodes mask probability.
- [x] Benchmark: random frontend tensor across available local providers; no inference server.
- [x] Offline: service worker + Comlink RPC; save app shell/current ONNX; load saved ONNX offline.
- [x] Inter font.
- [x] Backend accepts validated model + imgsz only for export.
- [x] Build/lint/API/export checks.

## v7 UX/task pass

- [x] Replace arrow and >= Unicode glyphs in rendered UI.
- [x] Match stage badge and webcam corner radius.
- [x] Use relative font sizing; verify minimum computed size >= 8px.
- [x] Delegate WASM thread count to ONNX Runtime Web auto selection.
- [x] Add segmentation/localization/OBB output task selector.
- [x] Add downloadable source ZIP without dependencies/build artifacts.
- [x] Browser-test all output tasks and source download.

## v8 official-output cleanup

- [x] Remove OBB option and all custom OBB geometry code.
- [x] Keep only YOLOE-native segmentation masks and detection boxes.
- [x] Regenerate downloadable source ZIP and redeploy.

## v10 frontend modernization

- [x] Upgrade Vite to 8.3.1 and plugin-react to 6.1.1.
- [x] Upgrade TypeScript to stable 7.0.2 and fix side-effect CSS typing.
- [x] Refresh runtime dependency baselines without changing application behavior.
- [x] Pin Bun 1.4.2 via packageManager.
- [x] Run strict typecheck, Oxlint/Oxfmt, Knip, Ruff, axe, Lighthouse.
- [x] Run public-tunnel fake-camera export/load smoke test.
- [x] Regenerate source ZIP and verify public artifacts.

## v11 localization-only runtime

- [x] Make CPU/WASM the default and Auto-preferred inference backend.
- [x] Change default object score to 0.010.
- [x] Remove task selector and segmentation-only threshold/rendering UI.
- [x] Export official detection-only YOLOE-26 architecture with baked visual prompt.
- [x] Add guaranteed painted post-export local-runtime loading state.
- [x] Validate detect ONNX output, browser flow, lint/type/deadcode/Ruff/a11y.
- [x] Regenerate downloadable source ZIP.

## v12 model dropdown tasks

- [x] Remove Auto from Inference backend; keep CPU/WASM and WebGPU only.
- [x] Restore YOLOE-26 segmentation variants in the Model dropdown.
- [x] Keep YOLOE-26n Object Localization as the default model.
- [x] Make selected model determine detect vs segment behavior without a task dropdown.
- [x] Restore mask threshold only for segmentation models.
- [x] Validate both ONNX export shapes and both browser runtime paths.

## App.tsx targeted render cleanup

- [x] Convert drawing state to drawingRef.
- [x] Throttle FPS and diagnostics React updates to 250 ms.
- [x] Keep promptValid and other state ownership unchanged.
- [x] Validate format/type/lint/deadcode/build/a11y and browser pointer/inference flow.
