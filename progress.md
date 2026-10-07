# Progress

## 2026-10-07: Active task derivation cleanup

- Compute activeTask once in App.tsx and pass it to useInferenceRuntime.
- Remove the hook's duplicate derivation and returned activeTask; reuse the input in its loading message.
- Verified with Bun typecheck, lint, Oxfmt, and git diff --check.

## 2026-10-07: Local production build

- Regenerated source ZIP and passed Bun production build (including TypeScript).
- Started FastAPI on http://localhost:8000 serving dist and verified page, JavaScript asset, and API health.
- Stopped the temporary Cloudflare tunnel at the user's request.
