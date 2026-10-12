# Vendored MediaPipe

Third-party files, bundled so face tracking runs fully offline inside the extension.

| File | What it is |
|---|---|
| `vision_bundle.mjs` | `@mediapipe/tasks-vision` 1.1.0 (ES module bundle) |
| `wasm/vision_wasm_internal.{js,wasm}` | Its SIMD WebAssembly runtime |
| `face_landmarker.task` | Google's float16 Face Landmarker model (blendshapes + landmarks) |

All are unmodified upstream releases from Google, licensed under Apache 2.0. Don't edit them by hand.
