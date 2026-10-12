// The sensor: owns the webcam and MediaPipe, streams one small frame summary per camera frame
// to every connected port (the focused x.com tab, or the settings page while calibrating).
import { FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const url = (p) => chrome.runtime.getURL(p);
const IDLE_STOP_MS = 15000; // keep the camera warm briefly so tab switches don't pay the startup cost

const ports = new Set();
let status = { state: 'idle' };
let landmarkerPromise = null;
let running = false;
let stream = null;
let stopTimer = null;

function broadcast(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch { ports.delete(p); }
  }
}

function setStatus(next) {
  status = next;
  broadcast({ type: 'status', ...status });
}

async function createLandmarker() {
  const fileset = {
    wasmLoaderPath: url('vendor/mediapipe/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: url('vendor/mediapipe/wasm/vision_wasm_internal.wasm'),
  };
  let lastError;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: url('vendor/mediapipe/face_landmarker.task'), delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// MediaPipe face mesh indices (subject's right eye appears on the image's left).
const EYES = [
  { left: 33, right: 133, top: 159, bottom: 145, iris: 468 },  // subject's right eye
  { left: 362, right: 263, top: 386, bottom: 374, iris: 473 }, // subject's left eye
];

// Iris position inside the eye, in the eye's own frame so head roll doesn't leak in.
//   h: 0 at the image-left corner, 1 at the image-right corner
//   v: offset below the corner line, as a fraction of eye width (positive = looking down)
//   lid: eyelid opening as a fraction of eye width (drops when looking down)
function eyeFeatures(lm, eye, aspect) {
  const P = (i) => ({ x: lm[i].x * aspect, y: lm[i].y });
  const a = P(eye.left), b = P(eye.right), iris = P(eye.iris), top = P(eye.top), bottom = P(eye.bottom);
  const ux = b.x - a.x, uy = b.y - a.y;
  const len = Math.hypot(ux, uy) || 1;
  const u = { x: ux / len, y: uy / len };
  const n = { x: -u.y, y: u.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return {
    h: ((iris.x - a.x) * u.x + (iris.y - a.y) * u.y) / len,
    v: ((iris.x - mid.x) * n.x + (iris.y - mid.y) * n.y) / len,
    lid: Math.hypot(top.x - bottom.x, top.y - bottom.y) / len,
  };
}

function summarize(result, t, aspect) {
  const categories = result.faceBlendshapes?.[0]?.categories;
  const lm = result.faceLandmarks?.[0];
  if (!categories || !lm || lm.length < 478) return { type: 'frame', t, face: false };
  const s = {};
  for (const c of categories) s[c.categoryName] = c.score;

  // Column-major 4x4 head pose. Rotation R[r][c] = m[c*4 + r]; translation in m[12..14] (cm).
  const m = result.facialTransformationMatrixes?.[0]?.data;
  const pitch = m ? Math.atan2(m[6], m[10]) : 0;
  const yaw = m ? Math.asin(Math.max(-1, Math.min(1, -m[2]))) : 0;

  const [r, l] = EYES.map((e) => eyeFeatures(lm, e, aspect));
  const avg2 = (x, y) => (x + y) / 2;
  return {
    type: 'frame',
    t,
    face: true,
    smile: avg2(s.mouthSmileLeft, s.mouthSmileRight),
    frown: avg2(s.mouthFrownLeft, s.mouthFrownRight),
    blink: avg2(s.eyeBlinkLeft, s.eyeBlinkRight),
    g: {
      irisH: avg2(r.h, l.h),
      irisV: avg2(r.v, l.v),
      lid: avg2(r.lid, l.lid),
      bsH: avg2(s.eyeLookInRight, s.eyeLookOutLeft) - avg2(s.eyeLookOutRight, s.eyeLookInLeft),
      bsV: avg2(s.eyeLookDownLeft, s.eyeLookDownRight) - avg2(s.eyeLookUpLeft, s.eyeLookUpRight),
      pitch,
      yaw,
      tx: m ? m[12] : 0,
      ty: m ? m[13] : 0,
    },
  };
}

async function start() {
  if (running) return;
  running = true;
  setStatus({ state: 'starting' });
  try {
    landmarkerPromise ??= createLandmarker();
    const [landmarker, media] = await Promise.all([
      landmarkerPromise,
      navigator.mediaDevices.getUserMedia({
        audio: false,
        // Higher resolution gives the iris landmarks more pixels to work with.
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      }),
    ]);
    stream = media;
    if (!running) return stopStream();
    const track = stream.getVideoTracks()[0];
    // maxBufferSize 1: always process the newest frame, never a backlog.
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    setStatus({ state: 'running', fps: track.getSettings().frameRate });

    let useBitmap = false;
    while (running) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      try {
        const t = performance.now();
        let result;
        if (useBitmap) {
          const bmp = await createImageBitmap(frame);
          result = landmarker.detectForVideo(bmp, t);
          bmp.close();
        } else {
          try {
            result = landmarker.detectForVideo(frame, t);
          } catch {
            useBitmap = true;
            continue;
          }
        }
        broadcast(summarize(result, t, frame.displayWidth / frame.displayHeight));
        if (previewPorts.size && t - lastPreviewAt >= PREVIEW_INTERVAL_MS) {
          lastPreviewAt = t;
          sendPreview(frame, result);
        }
      } finally {
        frame.close();
      }
    }
    reader.cancel().catch(() => {});
    if (running) {
      // Track ended underneath us (camera unplugged, taken by another app).
      running = false;
      stopStream();
      setStatus({ state: 'error', code: 'camera-ended', message: 'The camera stopped.' });
    }
  } catch (e) {
    running = false;
    stopStream();
    if (!(e instanceof DOMException)) landmarkerPromise = null;
    const code =
      e?.name === 'NotAllowedError' ? 'camera-denied'
      : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'no-camera'
      : e?.name === 'NotReadableError' ? 'camera-busy'
      : 'failed';
    setStatus({ state: 'error', code, message: String(e?.message || e) });
  }
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function stop() {
  running = false;
  stopStream();
  setStatus({ state: 'idle' });
}

// ---------- camera bubble preview ----------
// A small mirrored, face-centred thumbnail with the tracked points drawn on, sent only to ports that ask for it.

const PREVIEW_SIZE = 192;
const PREVIEW_INTERVAL_MS = 50; // ~20 fps is plenty for a bubble
const previewPorts = new Set();
let lastPreviewAt = 0;
let crop = null; // smoothed face box in frame pixels
const previewCanvas = document.createElement('canvas');
previewCanvas.width = previewCanvas.height = PREVIEW_SIZE;
const pctx = previewCanvas.getContext('2d');

function sendPreview(frame, result) {
  const W = frame.displayWidth, H = frame.displayHeight;
  const lm = result.faceLandmarks?.[0];

  // Square box around the face (1.7× its size), smoothed so the bubble doesn't jitter.
  let target;
  if (lm) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of lm) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const size = Math.max((x1 - x0) * W, (y1 - y0) * H) * 1.7;
    target = { cx: ((x0 + x1) / 2) * W, cy: ((y0 + y1) / 2) * H, size };
  } else {
    target = crop ?? { cx: W / 2, cy: H / 2, size: Math.min(W, H) };
  }
  crop = crop ? {
    cx: crop.cx + 0.3 * (target.cx - crop.cx),
    cy: crop.cy + 0.3 * (target.cy - crop.cy),
    size: crop.size + 0.15 * (target.size - crop.size),
  } : target;
  const size = Math.min(crop.size, W, H);
  const sx = Math.max(0, Math.min(W - size, crop.cx - size / 2));
  const sy = Math.max(0, Math.min(H - size, crop.cy - size / 2));
  const k = PREVIEW_SIZE / size;

  pctx.save();
  // Mirror, like a selfie camera.
  pctx.translate(PREVIEW_SIZE, 0);
  pctx.scale(-1, 1);
  pctx.drawImage(frame, sx, sy, size, size, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  if (lm) {
    const at = (p) => [(p.x * W - sx) * k, (p.y * H - sy) * k];
    pctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (let i = 0; i < 468; i += 5) {
      const [x, y] = at(lm[i]);
      pctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
    pctx.strokeStyle = '#1d9bf0';
    pctx.lineWidth = 1.5;
    for (const c of [468, 473]) {
      const [x, y] = at(lm[c]);
      const [ex] = at(lm[c + 1]);
      pctx.beginPath();
      pctx.arc(x, y, Math.max(2.5, Math.abs(ex - x)), 0, Math.PI * 2);
      pctx.stroke();
      pctx.fillStyle = '#1d9bf0';
      pctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
  pctx.restore();

  const msg = { type: 'preview', face: !!lm, image: previewCanvas.toDataURL('image/jpeg', 0.72) };
  for (const p of previewPorts) {
    try { p.postMessage(msg); } catch { previewPorts.delete(p); }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'lazyscroll-sensor') return;
  ports.add(port);
  clearTimeout(stopTimer);
  port.postMessage({ type: 'status', ...status });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    previewPorts.delete(port);
    if (!ports.size) stopTimer = setTimeout(stop, IDLE_STOP_MS);
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'retry' && !running) start();
    if (msg?.type === 'preview') {
      if (msg.on) previewPorts.add(port); else previewPorts.delete(port);
    }
  });
  start();
});
