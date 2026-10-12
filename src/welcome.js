const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let settings = { ...LAZYSCROLL_DEFAULTS };

// ---------------------------------------------------------------- camera permission

async function refreshCamera() {
  let state = 'prompt';
  try {
    state = (await navigator.permissions.query({ name: 'camera' })).state;
  } catch {}
  const status = $('#camera-status');
  const btn = $('#camera-btn');
  btn.hidden = state === 'granted';
  if (state === 'granted') {
    status.textContent = 'Camera allowed.';
    status.className = 'ok';
  } else if (state === 'denied') {
    status.innerHTML = 'Camera is blocked for LazyScroll. Allow it from the camera icon in the address bar, or in ' +
      '<code>chrome://settings/content/camera</code>, then reload this page.';
    status.className = 'err';
  } else {
    status.textContent = 'LazyScroll needs your webcam. Video is processed on this computer and never stored or sent anywhere.';
    status.className = 'muted';
  }
  return state;
}

$('#camera-btn').addEventListener('click', async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
  } catch {}
  await refreshCamera();
  connectSensor();
});

// ---------------------------------------------------------------- sensor

let port = null;
let sensor = { state: 'idle' };
let onFrame = null;            // calibration/test hook
let lastFrame = null;
const liveGaze = new GazeScroller(settings);

async function connectSensor() {
  if (port) return;
  await chrome.runtime.sendMessage({ to: 'background', type: 'ensure-sensor' }).catch(() => {});
  port = chrome.runtime.connect({ name: 'lazyscroll-sensor' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'status') {
      sensor = msg;
      return drawLive();
    }
    lastFrame = msg;
    onFrame?.(msg);
    liveGaze.push(msg);
    drawLive();
  });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectSensor, 1000);
  });
}

let smileRest = null;
function drawLive() {
  const st = $('#live-status');
  if (sensor.state === 'error') {
    st.textContent = `Camera: ${sensor.code}. ${sensor.message || ''}`;
    st.className = 'err small';
  } else if (sensor.state !== 'running') {
    st.textContent = 'Starting camera…';
    st.className = 'muted small';
  } else if (!lastFrame?.face) {
    st.textContent = 'No face detected. Face the camera with your face well lit.';
    st.className = 'warn small';
  } else {
    st.textContent = settings.gazeModel
      ? `Tracking. Gaze accuracy about ±${Math.round(settings.gazeModel.rmsY * 50)}% of screen height.`
      : 'Tracking. Calibrate to enable gaze scrolling.';
    st.className = 'muted small';
  }

  const f = lastFrame?.face ? lastFrame : null;
  // Smile bar: relative to a slow-moving resting level, so you can see how far a smile moves it.
  if (f) smileRest = smileRest == null ? f.smile : smileRest + 0.02 * (Math.min(f.smile, smileRest + 0.02) - smileRest);
  const delta = f ? Math.max(0, f.smile - smileRest) : 0;
  const span = settings.smileThreshold * 1.5;
  $('#live-smile').style.width = `${Math.min(1, delta / span) * 100}%`;
  $('#live-smile-thr').style.left = `${(settings.smileThreshold / span) * 100}%`;
  $('#live-smile-num').textContent = f ? delta.toFixed(2) : '–';

  const y = liveGaze.screen?.y;
  const zone = `${((1.2 - settings.scrollEnter) / 2.4) * 100}%`;
  $('#zone-up').style.width = $('#zone-down').style.width = zone;
  $('#live-gaze').style.left = y == null ? '50%' : `${((Math.max(-1.2, Math.min(1.2, y)) + 1.2) / 2.4) * 100}%`;
  $('#live-gaze').style.opacity = y == null ? 0.3 : 1;
  $('#live-gaze-num').textContent = y == null ? '–' : y.toFixed(2);
}

// ---------------------------------------------------------------- calibration

const overlay = $('#calib-overlay');
const dot = $('#calib-dot');
const text = $('#calib-text');

function placeDot(x, y) {
  dot.style.left = `${((x + 1) / 2) * 100}%`;
  dot.style.top = `${((y + 1) / 2) * 100}%`;
}

async function collect(settleMs, collectMs) {
  await sleep(settleMs);
  dot.classList.add('collect');
  const samples = [];
  onFrame = (f) => { if (f.face) samples.push(f); };
  await sleep(collectMs);
  onFrame = null;
  dot.classList.remove('collect');
  return samples;
}

async function enterFullscreen() {
  overlay.hidden = false;
  try {
    await document.documentElement.requestFullscreen();
  } catch {}
  await sleep(400);
  return !!document.fullscreenElement;
}

function leaveOverlay() {
  overlay.hidden = true;
  overlay.classList.remove('test');
  onFrame = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Centre first, then a snake through the 3×3 grid, 5% in from each edge.
const GRID = [[0, 0], [-0.9, -0.9], [0, -0.9], [0.9, -0.9], [0.9, 0], [-0.9, 0], [-0.9, 0.9], [0, 0.9], [0.9, 0.9]];

async function calibrate() {
  const result = $('#calibrate-result');
  if (sensor.state !== 'running') {
    result.textContent = 'The camera isn\'t running yet. Allow the camera first and wait for "Tracking" below.';
    result.className = 'err';
    return;
  }
  if (!(await enterFullscreen())) {
    leaveOverlay();
    result.textContent = 'Calibration needs full screen. Allow it and try again.';
    result.className = 'err';
    return;
  }

  try {
    dot.hidden = false;
    text.textContent = 'Follow the dot with your eyes. Keep your head where it normally is.';
    placeDot(0, 0);
    await sleep(1200);

    const points = [];
    for (const [x, y] of GRID) {
      placeDot(x, y);
      const samples = await collect(650, 850);
      if (samples.length < 5) throw new Error('Lost your face. Make sure your face is well lit and visible to the camera.');
      points.push({ x, y, samples });
    }

    dot.hidden = true;
    text.textContent = 'Now look down at your keyboard (or desk).';
    const keyboard = await collect(900, 1100);

    dot.hidden = false;
    placeDot(0, 0);
    text.textContent = 'Look at the dot and give a slight, natural smile.';
    const smiling = await collect(900, 1300);

    const model = fitGazeModel(points.map((p) => ({ x: p.x, y: p.y, samples: p.samples.map((f) => f.g) })), keyboard.map((f) => f.g));
    const smileFit = fitSmileThreshold(points.flatMap((p) => p.samples.map((f) => f.smile)), smiling.map((f) => f.smile));

    const update = { gazeModel: model };
    if (smileFit.ok) update.smileThreshold = +smileFit.threshold.toFixed(2);
    await chrome.storage.local.set(update);

    const vErr = Math.round(model.rmsY * 50), hErr = Math.round(model.rmsX * 50);
    const notes = [`Done. Accuracy: about ±${vErr}% of screen height, ±${hErr}% of width.`];
    if (vErr > 15) notes.push('That\'s rough: better, even lighting on your face and a camera at eye level help a lot. Try again.');
    notes.push(model.belowLimit ? 'Looking below the screen is recognised.' : 'Couldn\'t tell your keyboard glance apart from the screen\'s bottom edge; using the default margin.');
    if (!smileFit.ok) notes.push('Didn\'t catch a clear smile, so the smile setting is unchanged.');
    else notes.push(`Smile sensitivity set to ${update.smileThreshold}.`);
    result.textContent = notes.join(' ');
    result.className = vErr > 15 ? 'warn' : 'ok';
    $('#test-btn').hidden = false;
  } catch (e) {
    result.textContent = e.message;
    result.className = 'err';
  } finally {
    leaveOverlay();
  }
}

// Full-screen view of the live gaze point with the scroll bands, to check calibration.
async function testTracking() {
  if (!settings.gazeModel) return;
  if (!(await enterFullscreen())) return leaveOverlay();
  overlay.classList.add('test');
  dot.hidden = false;
  text.textContent = 'Look around. Shaded bands scroll. Click or press Esc to finish.';
  const bands = overlay.querySelectorAll('.band');
  bands.forEach((b) => { b.hidden = false; b.style.height = `${((1 - settings.scrollEnter) / 2) * 100}%`; });
  const scroller = new GazeScroller(settings);
  onFrame = (f) => {
    const r = scroller.push(f);
    if (!r.screen) return;
    placeDot(Math.max(-1, Math.min(1, r.screen.x)), Math.max(-1, Math.min(1, r.screen.y)));
    dot.classList.toggle('offscreen', r.zone === 'offscreen');
  };
  const done = () => {
    bands.forEach((b) => { b.hidden = true; });
    dot.classList.remove('offscreen');
    leaveOverlay();
    overlay.removeEventListener('click', done);
    document.removeEventListener('fullscreenchange', onFs);
  };
  const onFs = () => { if (!document.fullscreenElement) done(); };
  overlay.addEventListener('click', done);
  document.addEventListener('fullscreenchange', onFs);
}

$('#calibrate-btn').addEventListener('click', calibrate);
$('#test-btn').addEventListener('click', testTracking);

// ---------------------------------------------------------------- settings form

const form = $('#settings');

function fillForm() {
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else {
      el.value = settings[el.name];
      el.nextElementSibling.textContent = settings[el.name];
    }
  }
  $('#test-btn').hidden = !settings.gazeModel;
}

form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  const value = el.type === 'checkbox' ? el.checked : Number(el.value);
  if (el.type !== 'checkbox') el.nextElementSibling.textContent = value;
  const update = { [el.name]: value };
  // Keep the stop point a little inside the start point so scrolling doesn't stutter at the boundary.
  if (el.name === 'scrollEnter') update.scrollExit = Math.max(0.1, +(value - 0.15).toFixed(2));
  chrome.storage.local.set(update);
});

$('#reset-btn').addEventListener('click', async () => {
  // Keep the calibration; reset only the knobs.
  const { gazeModel, ...rest } = LAZYSCROLL_DEFAULTS;
  await chrome.storage.local.set(rest);
});

chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== 'local') return;
  settings = await lazyScrollSettings();
  liveGaze.configure(settings);
  fillForm();
  drawLive();
});

(async () => {
  settings = await lazyScrollSettings();
  liveGaze.configure(settings);
  fillForm();
  const cam = await refreshCamera();
  if (cam === 'granted') connectSensor();
})();
