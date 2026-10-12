import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Math, Object, Array, Number, console });
vm.runInContext(readFileSync(new URL('../src/shared.js', import.meta.url), 'utf8'), ctx);
const { SmileDetector, FrownDetector, GazeScroller, fitGazeModel, predictGaze, fitSmileThreshold, LAZYSCROLL_DEFAULTS: D } = ctx;

// Deterministic noise.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) - 0.5;

// Synthetic "true" relationship between where you look and what the sensor reports.
function features(x, y, noise = 0.01) {
  return {
    irisH: 0.5 + 0.12 * x + noise * rand(),
    irisV: 0.02 + 0.06 * y + noise * rand(),
    lid: 0.3 - 0.05 * y + noise * rand(),
    bsH: 0.4 * x + noise * rand(),
    bsV: 0.25 * y + noise * rand(),
    pitch: 0.08 * y + noise * rand(),
    yaw: 0.05 * x + noise * rand(),
    tx: noise * rand(),
    ty: noise * rand(),
  };
}

function calibrated() {
  const grid = [-0.9, 0, 0.9];
  const points = grid.flatMap((y) => grid.map((x) => ({ x, y, samples: Array.from({ length: 25 }, () => features(x, y)) })));
  const keyboard = Array.from({ length: 25 }, () => features(0, 2.2));
  return fitGazeModel(points, keyboard);
}

function run(scroller, x, y, ms, t0 = 0) {
  let r;
  for (let t = t0; t <= t0 + ms; t += 33) r = scroller.push({ t, face: true, blink: 0.1, smile: 0, g: features(x, y) });
  return r;
}

test('gaze model recovers where you look', () => {
  const model = calibrated();
  assert.ok(model.rmsY < 0.05 && model.rmsX < 0.05, `rms ${model.rmsX} ${model.rmsY}`);
  const p = predictGaze(model, features(0.3, -0.5, 0));
  assert.ok(Math.abs(p.x - 0.3) < 0.08 && Math.abs(p.y + 0.5) < 0.08, JSON.stringify(p));
  assert.ok(model.belowLimit > 1.05 && model.belowLimit < 2.2, `belowLimit ${model.belowLimit}`);
});

test('dead zone: reading the middle of the page never scrolls', () => {
  const s = new GazeScroller({ ...D, gazeModel: calibrated() });
  for (const [x, y] of [[0, 0], [0, 0.4], [0, -0.4], [0.8, 0.3], [-0.8, -0.3]]) {
    s.reset();
    assert.equal(run(s, x, y, 1500).velocity, 0, `scrolled at ${x},${y}`);
  }
});

test('looking at the bottom band scrolls down, top band scrolls up', () => {
  const s = new GazeScroller({ ...D, gazeModel: calibrated() });
  assert.ok(run(s, 0, 0.9, 800).velocity > 0);
  s.reset();
  assert.ok(run(s, 0, -0.9, 800).velocity < 0);
});

test('scrolling waits for the dwell time', () => {
  const s = new GazeScroller({ ...D, gazeModel: calibrated() });
  assert.equal(run(s, 0, 0.9, 100).velocity, 0);
});

test('looking above, below or beside the screen does nothing', () => {
  const s = new GazeScroller({ ...D, gazeModel: calibrated() });
  for (const [x, y] of [[0, 2.2], [0, -1.6], [1.6, 0.9], [-1.6, -0.9]]) {
    s.reset();
    const r = run(s, x, y, 1500);
    assert.equal(r.velocity, 0, `scrolled at ${x},${y}`);
    assert.equal(r.zone, 'offscreen');
  }
});

test('glancing back to the middle stops scrolling', () => {
  const s = new GazeScroller({ ...D, gazeModel: calibrated() });
  assert.ok(run(s, 0, 0.9, 800).velocity > 0);
  assert.equal(run(s, 0, 0, 600, 900).velocity, 0);
});

test('short blinks do not trigger down-scroll', () => {
  const s = new GazeScroller({ ...D, gazeModel: calibrated() });
  run(s, 0, 0, 500);
  let r;
  // Eyelids closing look like looking far down for ~200 ms.
  for (let t = 533; t < 733; t += 33) r = s.push({ t, face: true, blink: 0.9, smile: 0, g: features(0, 1.0) });
  assert.equal(r.velocity, 0);
});

test('no calibration, no scrolling', () => {
  const s = new GazeScroller({ ...D, gazeModel: null });
  assert.equal(run(s, 0, 0.9, 800).velocity, 0);
});

function smileRun(det, values, t0 = 0) {
  let r, t = t0;
  for (const v of values) { r = det.push({ t, face: true, smile: v }); t += 33; }
  return r;
}

test('smile above baseline fires after the hold time', () => {
  const det = new SmileDetector(D);
  smileRun(det, Array(10).fill(0.05));
  assert.equal(det.base != null, true);
  const r = smileRun(det, Array(8).fill(0.35), 330);
  assert.equal(r.fired, true);
});

test('noise and an already-smiling face do not fire', () => {
  const det = new SmileDetector(D);
  const r = smileRun(det, Array.from({ length: 200 }, () => 0.1 + 0.08 * rand()));
  assert.equal(r.fired, false);
  const det2 = new SmileDetector(D);
  assert.equal(smileRun(det2, Array(100).fill(0.6)).fired, false);
});

test('one-frame spike does not fire', () => {
  const det = new SmileDetector(D);
  smileRun(det, Array(10).fill(0.05));
  const r = smileRun(det, [0.6, 0.05, 0.05, 0.05], 330);
  assert.equal(r.fired, false);
});

test('smile threshold calibration', () => {
  const fit = fitSmileThreshold(Array.from({ length: 200 }, () => 0.08 + 0.02 * rand()), Array(40).fill(0.4));
  assert.equal(fit.ok, true);
  assert.ok(fit.threshold > 0.05 && fit.threshold < 0.32, `${fit.threshold}`);
  assert.equal(fitSmileThreshold(Array(50).fill(0.1), Array(50).fill(0.11)).ok, false);
});

function frownRun(det, values, t0 = 0) {
  let r, t = t0;
  for (const v of values) { r = det.push({ t, face: true, smile: 0.05, frown: v }); t += 33; }
  return r;
}

test('sad face fires the frown detector; smiles and noise do not', () => {
  const det = new FrownDetector(D);
  frownRun(det, Array(10).fill(0.02));
  assert.equal(frownRun(det, Array(8).fill(0.3), 330).fired, true);

  const calm = new FrownDetector(D);
  assert.equal(frownRun(calm, Array.from({ length: 200 }, () => 0.03 + 0.05 * rand())).fired, false);

  // The smile signal doesn't leak into the frown detector.
  const smiling = new FrownDetector(D);
  let r, t = 0;
  for (let i = 0; i < 60; i++) { r = smiling.push({ t, face: true, smile: i < 10 ? 0.05 : 0.7, frown: 0.02 }); t += 33; }
  assert.equal(r.fired, false);
});

test('frown and smile thresholds are independent', () => {
  const det = new FrownDetector({ ...D, smileThreshold: 0.01, frownThreshold: 0.4 });
  frownRun(det, Array(10).fill(0.02));
  assert.equal(frownRun(det, Array(10).fill(0.3), 330).fired, false);
});
