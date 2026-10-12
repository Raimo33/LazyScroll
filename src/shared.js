// Loaded by every context: service worker (importScripts), offscreen sensor, settings page, content script.
// Everything below the settings helpers is pure logic so it can be unit-tested in Node.

globalThis.LAZYSCROLL_DEFAULTS = {
  enabled: true,
  disabledSites: [],      // hostnames where LazyScroll stays off
  likeOnSmile: true,      // only on sites with a like adapter (currently X)
  scrollWithGaze: true,
  showHud: true,
  debugGaze: false,       // draw the estimated gaze point on the page
  cameraBubble: false,    // small draggable camera preview on pages (handy for demo recordings)
  bubblePos: null,        // { x, y } of the bubble's centre as fractions of the window; null = bottom-right

  // Smile → like
  smileThreshold: 0.15,   // rise in smile score (0–1) over the per-tweet baseline that counts as a smile
  holdMs: 120,            // smile must stay above the threshold this long (filters single noisy frames)
  baselineMs: 150,        // how long to sample your face when a tweet becomes focused

  // Gaze → scroll (needs calibration)
  gazeModel: null,        // fitted by calibration, see fitGazeModel
  scrollEnter: 0.65,      // start scrolling once gaze is this far from the middle of the page (1 = page edge)
  scrollExit: 0.5,        // stop once it falls back below this (hysteresis)
  scrollDwellMs: 220,     // gaze must stay in a scroll band this long before scrolling starts
  scrollMaxSpeed: 1400,   // px per second at the very edge
  offscreenMargin: 0.15,  // looking this far past a screen edge counts as off-screen: no scrolling
};

globalThis.lazyScrollSettings = async function () {
  const stored = await chrome.storage.local.get(Object.keys(LAZYSCROLL_DEFAULTS));
  return { ...LAZYSCROLL_DEFAULTS, ...stored };
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// A frame from the sensor:
//   { t, face, smile, blink, g: { irisH, irisV, lid, bsH, bsV, pitch, yaw, tx, ty } }
// g holds the raw gaze features; fitGazeModel learns how they map to the screen.
const GAZE_FEATURES = ['irisH', 'irisV', 'lid', 'bsH', 'bsV', 'pitch', 'yaw', 'tx', 'ty'];

// ---------------------------------------------------------------- smile

class SmileDetector {
  constructor(opts) {
    this.configure(opts);
    this.reset();
  }

  configure({ smileThreshold, holdMs, baselineMs, driftMs = 6000 }) {
    Object.assign(this, { smileThreshold, holdMs, baselineMs, driftMs });
  }

  reset() {
    this.ema = null;
    this.base = null;
    this.sampleStart = null;
    this.sum = 0;
    this.n = 0;
    this.overSince = null;
    this.lastT = null;
  }

  push(f) {
    if (!f.face) {
      this.overSince = null;
      return { phase: this.base == null ? 'baseline' : 'watching', delta: 0, fired: false };
    }
    this.ema = this.ema == null ? f.smile : this.ema + 0.5 * (f.smile - this.ema);
    const dt = this.lastT == null ? 0 : f.t - this.lastT;
    this.lastT = f.t;

    if (this.base == null) {
      this.sampleStart ??= f.t;
      this.sum += this.ema;
      this.n++;
      if (f.t - this.sampleStart >= this.baselineMs) this.base = this.sum / this.n;
      return { phase: 'baseline', delta: 0, fired: false };
    }

    const delta = this.ema - this.base;
    if (delta >= this.smileThreshold) {
      this.overSince ??= f.t;
      return { phase: 'watching', delta, fired: f.t - this.overSince >= this.holdMs };
    }
    this.overSince = null;
    // Let the baseline follow slow changes (relaxing, lighting) so only quick smiles count.
    this.base += (this.ema - this.base) * Math.min(1, dt / this.driftMs);
    return { phase: 'watching', delta, fired: false };
  }
}

// ---------------------------------------------------------------- gaze

// One Euro filter (Casiez et al. 2012): heavy smoothing while the gaze rests, little lag when it moves.
class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.4, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, tMs) {
    if (this.x == null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const dx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

// Solve A x = b for a small dense system (Gaussian elimination with partial pivoting).
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Ridge regression on standardised features. Returns { w, b } in standardised space.
function ridge(X, t, lambda) {
  const n = X.length, d = X[0].length;
  const tMean = t.reduce((s, v) => s + v, 0) / n;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const rhs = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const x = X[i], y = t[i] - tMean;
    for (let a = 0; a < d; a++) {
      rhs[a] += x[a] * y;
      for (let c = a; c < d; c++) A[a][c] += x[a] * x[c];
    }
  }
  for (let a = 0; a < d; a++) {
    A[a][a] += lambda;
    for (let c = 0; c < a; c++) A[a][c] = A[c][a];
  }
  return { w: solveLinear(A, rhs), b: tMean };
}

function standardise(g, model) {
  return GAZE_FEATURES.map((k, i) => (g[k] - model.mean[i]) / model.std[i]);
}

// Gaze point in screen units: x -1 left edge … +1 right edge, y -1 top edge … +1 bottom edge.
function predictGaze(model, g) {
  const z = standardise(g, model);
  let x = model.bx, y = model.by;
  for (let i = 0; i < z.length; i++) {
    x += model.wx[i] * z[i];
    y += model.wy[i] * z[i];
  }
  return { x, y };
}

// points:   [{ x, y, samples: [g, …] }]   on-screen targets in screen units
// keyboard: [g, …]                       samples while looking below the screen (optional)
function fitGazeModel(points, keyboard = []) {
  const all = points.flatMap((p) => p.samples.map((g) => ({ g, x: p.x, y: p.y })));
  const n = all.length;
  const mean = GAZE_FEATURES.map((k) => all.reduce((s, a) => s + a.g[k], 0) / n);
  const std = GAZE_FEATURES.map((k, i) =>
    Math.sqrt(all.reduce((s, a) => s + (a.g[k] - mean[i]) ** 2, 0) / n) || 1);
  const model = { mean, std };
  const Z = all.map((a) => standardise(a.g, model));
  // Lambda scales with n so it acts the same whatever the frame rate during calibration.
  const lambda = 0.02 * n;
  const fx = ridge(Z, all.map((a) => a.x), lambda);
  const fy = ridge(Z, all.map((a) => a.y), lambda);
  Object.assign(model, { wx: fx.w, bx: fx.b, wy: fy.w, by: fy.b });

  // Accuracy: distance between each target and the mean prediction for it.
  const errs = points.map((p) => {
    const preds = p.samples.map((g) => predictGaze(model, g));
    const mx = preds.reduce((s, q) => s + q.x, 0) / preds.length;
    const my = preds.reduce((s, q) => s + q.y, 0) / preds.length;
    return { dx: mx - p.x, dy: my - p.y };
  });
  model.rmsX = Math.sqrt(errs.reduce((s, e) => s + e.dx ** 2, 0) / errs.length);
  model.rmsY = Math.sqrt(errs.reduce((s, e) => s + e.dy ** 2, 0) / errs.length);

  // Where "below the screen" starts: halfway between the bottom edge and the keyboard.
  model.belowLimit = null;
  if (keyboard.length) {
    const ky = percentile(keyboard.map((g) => predictGaze(model, g).y), 0.5);
    if (ky > 1.2) model.belowLimit = Math.max(1.05, (1 + ky) / 2);
  }
  return model;
}

// Turns raw frames into a smoothed gaze point and a scroll velocity.
// Zones (y in page units, -1 top edge … +1 bottom edge of the visible page):
//   |y| < scrollEnter             dead zone: reading, nothing happens
//   scrollEnter ≤ |y|, on screen  scroll band: scroll towards that edge
//   beyond a screen edge          off-screen (above/below/side): nothing happens
class GazeScroller {
  constructor(opts) {
    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.configure(opts);
    this.reset();
  }

  configure({ gazeModel, scrollEnter, scrollExit, scrollDwellMs, scrollMaxSpeed, offscreenMargin }) {
    Object.assign(this, { gazeModel, scrollEnter, scrollExit, scrollDwellMs, scrollMaxSpeed, offscreenMargin });
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.screen = null;    // smoothed gaze in screen units
    this.dir = 0;          // -1 up, +1 down, 0 idle
    this.candidate = 0;
    this.candidateSince = null;
    this.blinkSince = null;
  }

  // toPage maps screen units to page units; identity when the browser fills the screen.
  push(f, toPage = (p) => p) {
    if (!f.face || !this.gazeModel) {
      this.reset();
      return { screen: null, page: null, zone: 'none', velocity: 0 };
    }

    // Closing eyelids look like "looking down" to the tracker. Hold the last gaze through short blinks;
    // a long "blink" is really looking down, so stop holding after 400 ms.
    if (f.blink > 0.55) {
      this.blinkSince ??= f.t;
      if (this.screen && f.t - this.blinkSince < 400) return this.result(f, toPage);
    } else {
      this.blinkSince = null;
    }

    const raw = predictGaze(this.gazeModel, f.g);
    this.screen = { x: this.fx.filter(raw.x, f.t), y: this.fy.filter(raw.y, f.t) };
    return this.result(f, toPage);
  }

  zoneOf(screen, page) {
    const m = this.offscreenMargin;
    const below = this.gazeModel.belowLimit ?? 1 + m;
    if (Math.abs(screen.x) > 1 + m || screen.y < -1 - m || screen.y > below) return 'offscreen';
    // Past the page's own edges but still on the screen (browser toolbar, taskbar) counts as that edge.
    const y = clamp(page.y, -1, 1);
    if (y >= this.scrollEnter) return 'down';
    if (y <= -this.scrollEnter) return 'up';
    return 'dead';
  }

  result(f, toPage) {
    const page = toPage(this.screen);
    const zone = this.zoneOf(this.screen, page);
    const mag = Math.abs(clamp(page.y, -1, 1));

    if (this.dir !== 0 && (zone === 'offscreen' || mag < this.scrollExit || Math.sign(page.y) !== this.dir)) {
      this.dir = 0;
    }

    if (this.dir === 0) {
      const want = zone === 'down' ? 1 : zone === 'up' ? -1 : 0;
      if (want !== this.candidate) {
        this.candidate = want;
        this.candidateSince = f.t;
      }
      if (want && f.t - this.candidateSince >= this.scrollDwellMs) this.dir = want;
    }

    const strength = this.dir === 0 ? 0 : clamp((mag - this.scrollExit) / (1 - this.scrollExit), 0.15, 1);
    return { screen: this.screen, page, zone, velocity: this.dir * strength * this.scrollMaxSpeed };
  }
}

// ---------------------------------------------------------------- calibration helpers

function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// neutral / smiling: arrays of raw smile scores.
function fitSmileThreshold(neutral, smiling) {
  const restMedian = percentile(neutral, 0.5);
  const noise = percentile(neutral.map((x) => x - restMedian), 0.95);
  const gentle = percentile(smiling, 0.5) - restMedian;
  const ok = gentle > Math.max(0.05, noise * 2);
  const threshold = clamp(Math.max(noise * 2.5, gentle * 0.4), 0.04, 0.5);
  return { ok, threshold, noise, gentle };
}

Object.assign(globalThis, {
  GAZE_FEATURES, SmileDetector, OneEuro, GazeScroller, predictGaze, fitGazeModel, fitSmileThreshold, percentile,
});
